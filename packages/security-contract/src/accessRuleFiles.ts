import { pathCollisionKey } from "@dohc/workspace-contracts/path-floor";

// The folder marker, apart from the evaluator so `shareSelector.ts` can hide
// markers without importing the evaluator, which imports it. The relay keeps
// each folder's rule; the marker names the rule so it moves with the folder
// (ADR 0017).

export const FOLDER_MARKER_FILE = ".dohc-access";
export const FOLDER_MARKER_MAX_BYTES = 1024;

const RULE_ID = /^fr_[0-9a-f]{32}$/u;
const RULE_LINE = /^rule (\S+)$/u;

/** Whether this file is a folder marker, however the filesystem spells it. */
export function isFolderMarkerPath(path: string): boolean {
  return pathCollisionKey(path.slice(path.lastIndexOf("/") + 1)) === FOLDER_MARKER_FILE;
}

/** The folder a file is in: "" for the workspace root. */
export function accessRuleFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Whether a value is a rule id the relay mints. */
export function isFolderRuleId(value: unknown): value is string {
  return typeof value === "string" && RULE_ID.test(value);
}

/**
 * The marker's text for a rule. The revision changes the file on every rule
 * change, so each change takes its own position in the owner's log.
 */
export function folderMarkerText(ruleId: string, revision: number): string {
  return `# dohc keeps this folder's access rule on your server. Change it in Members settings.\n# Revision ${revision}\nrule ${ruleId}\n`;
}

/** The rule a marker names, or null when it names none or can't be read. */
export function parseFolderMarker(text: string): string | null {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\r$/u, "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const id = lines.length === 1 ? RULE_LINE.exec(lines[0]!)?.[1] : undefined;
  return isFolderRuleId(id) ? id : null;
}
