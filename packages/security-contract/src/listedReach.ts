import { accessRuleFolder, isAccessRuleRelatedPath } from "./accessRuleFiles";
import { SHARE_ACCESS_VALUES, shareAccessRank, type ShareAccess } from "./shareSelector";

/**
 * A member's reach as each of their share log pages lists it (`reach`): the
 * root's level and each folder where a rule gives the member a level other
 * than its parent's. A hidden folder is never listed, and the root is always
 * present, null when it is hidden.
 *
 * The relay keys both signatures, so they say only when the reach changed:
 * `signature` whenever the member's levels do, `visibilitySignature` only when
 * what they reach does.
 */
export interface ListedReach {
  readonly signature: string;
  readonly visibilitySignature: string;
  readonly rootLevel: ShareAccess | null;
  readonly folders: readonly { readonly path: string; readonly level: ShareAccess }[];
}

const MAX_LISTED_FOLDERS = 100_000;

function isLevel(value: unknown): value is ShareAccess {
  return typeof value === "string" && (SHARE_ACCESS_VALUES as readonly string[]).includes(value);
}

function isSignature(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/**
 * Reads a listed reach from the relay's answer or the share view's record,
 * or null when any part of it is unreadable. A folder path is exact, with no
 * leading or trailing slash and no empty segment; the root is not a listed
 * folder.
 */
export function parseListedReach(value: unknown): ListedReach | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isSignature(record.signature) || !isSignature(record.visibilitySignature)) return null;
  if (record.rootLevel !== null && !isLevel(record.rootLevel)) return null;
  if (!Array.isArray(record.folders) || record.folders.length > MAX_LISTED_FOLDERS) return null;
  const folders: { path: string; level: ShareAccess }[] = [];
  const seen = new Set<string>();
  for (const entry of record.folders as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { path, level } = entry as Record<string, unknown>;
    if (
      typeof path !== "string" ||
      path === "" ||
      path.split("/").some((segment) => segment === "")
    )
      return null;
    if (!isLevel(level) || seen.has(path)) return null;
    seen.add(path);
    folders.push({ path, level });
  }
  return {
    signature: record.signature,
    visibilitySignature: record.visibilitySignature,
    rootLevel: record.rootLevel,
    folders,
  };
}

/**
 * The level of the nearest listed folder at or above `folder`, the root
 * included. Folders match exactly, as a rule applies only in exactly its own
 * folder (`folderLevel` in `accessRules.ts`).
 */
export function listedFolderLevel(reach: ListedReach, folder: string): ShareAccess | null {
  const listed = new Map(reach.folders.map(({ path, level }) => [path, level]));
  for (let current = folder; current !== ""; current = accessRuleFolder(current)) {
    const level = listed.get(current);
    if (level !== undefined) return level;
  }
  return reach.rootLevel;
}

/**
 * The level a member has at a path, or null when they have none: an existing
 * file takes the level at its current path, a new file the level at the path
 * it would take. Members never reach a rule file. Every local gate asks this,
 * so a person and an agent get the same answer. The relay still decides each
 * write.
 */
export function levelAtPath(reach: ListedReach, path: string): ShareAccess | null {
  if (isAccessRuleRelatedPath(path)) return null;
  return listedFolderLevel(reach, accessRuleFolder(path));
}

/** The highest level the member has anywhere, or null when they reach nothing. */
export function highestListedLevel(reach: ListedReach): ShareAccess | null {
  let highest = reach.rootLevel;
  for (const { level } of reach.folders) {
    if (highest === null || shareAccessRank(level) > shareAccessRank(highest)) highest = level;
  }
  return highest;
}
