import { statSync, type BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";
import * as nativePath from "node:path";
import { pathCollisionKey } from "@dohc/workspace-contracts/path-floor";

type ContainmentPath = Pick<typeof nativePath, "isAbsolute" | "normalize" | "parse" | "sep" | "join">;
export type ContainmentStat = (path: string, options: { bigint: true }) => Pick<BigIntStats, "dev" | "ino">;

/**
 * Case-sensitive containment for paths with links resolved, including equality
 * after normalization. Native realpath returns stored names on Windows and
 * macOS; JavaScript realpathSync and Linux realpath can keep lookup spelling.
 * isInsideOrUnknown checks uncertain spellings by folder identity for exclusion.
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

function mayNameSameFolder(first: string, second: string): boolean {
  return pathCollisionKey(first) === pathCollisionKey(second) || /~\d/u.test(first) || /~\d/u.test(second);
}

// The child's ancestor at parent depth, when the spellings may name the same folders.
function ancestorForIdentityCheck(parent: string, child: string, path: ContainmentPath): string | null {
  if (!path.isAbsolute(parent) || !path.isAbsolute(child)) return null;
  const normalizedParent = path.normalize(parent), normalizedChild = path.normalize(child);
  const parentRoot = path.parse(normalizedParent).root, childRoot = path.parse(normalizedChild).root;
  if (!mayNameSameFolder(parentRoot, childRoot)) return null;
  const parentSegments = normalizedParent.slice(parentRoot.length).split(path.sep).filter(Boolean);
  const childSegments = normalizedChild.slice(childRoot.length).split(path.sep).filter(Boolean);
  if (parentSegments.length > childSegments.length
    || !parentSegments.every((segment, index) => mayNameSameFolder(segment, childSegments[index]!))) return null;
  return path.join(childRoot, ...childSegments.slice(0, parentSegments.length));
}

/**
 * Exclusion only: true means inside or unable to check folder identity.
 * Never use this result to grant access. Callers resolve symlinks first.
 * Exact containment and unrelated prefixes without short names need no stat.
 */
export function isInsideOrUnknownSync(parent: string, child: string, statPath: ContainmentStat = statSync, path: ContainmentPath = nativePath): boolean {
  if (isInside(parent, child, path)) return true;
  const ancestor = ancestorForIdentityCheck(parent, child, path);
  if (ancestor === null) return false;
  try {
    const parentStat = statPath(parent, { bigint: true }), ancestorStat = statPath(ancestor, { bigint: true });
    return parentStat.dev === ancestorStat.dev && parentStat.ino === ancestorStat.ino;
  } catch { return true; }
}

/** Async form of isInsideOrUnknownSync, with the same exclusion-only rule. */
export async function isInsideOrUnknown(parent: string, child: string, statPath: (path: string, options: { bigint: true }) => Promise<ReturnType<ContainmentStat>> = stat): Promise<boolean> {
  if (isInside(parent, child)) return true;
  const ancestor = ancestorForIdentityCheck(parent, child, nativePath);
  if (ancestor === null) return false;
  try {
    const [parentStat, ancestorStat] = await Promise.all([statPath(parent, { bigint: true }), statPath(ancestor, { bigint: true })]);
    return parentStat.dev === ancestorStat.dev && parentStat.ino === ancestorStat.ino;
  } catch { return true; }
}
