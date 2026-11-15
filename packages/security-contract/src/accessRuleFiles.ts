import { pathCollisionKey } from "@dohc/workspace-contracts/path-floor";

// Rule file names, apart from the evaluator so `shareSelector.ts` can hide
// rule files without importing the evaluator, which imports it.

export const ACCESS_RULE_FILE = "access.yaml";

function lastSegmentKey(path: string): string {
  return pathCollisionKey(path.slice(path.lastIndexOf("/") + 1));
}

/** Whether this file is a folder's rule, however the filesystem spells it. */
export function isAccessRulePath(path: string): boolean {
  return lastSegmentKey(path) === ACCESS_RULE_FILE;
}

/**
 * Whether this file is a rule or a copy of one: an editor's backup, swap or
 * temp file keeps the rule's emails, so members never see or write these either.
 * Any name containing `access.yaml` counts, so `Guide to access.yaml.md` is
 * hidden too: editors name copies too many ways to list, and hiding errs safe.
 */
export function isAccessRuleRelatedPath(path: string): boolean {
  return lastSegmentKey(path).includes(ACCESS_RULE_FILE);
}

/** The folder a rule file belongs to: "" for the workspace root. */
export function accessRuleFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
