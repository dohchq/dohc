import type { SkippedImportSource } from "../../ipc/bridgeContract";
import { IMPORT_COLLISION_RENAMES, IMPORT_SKIPPED_PATH_MAX_CHARS } from "../../ipc/channels";
import {
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "../../workspaces/workspaceEngineCaptureLimits";
import type { ErrorDetailField } from "./copyDetails";
import { SHELL_ERROR_MAX_CHARS } from "./useShellError";

// A path from a drop can run to 32,767 characters. A line shows its end, where
// the file's name is; Copy details keeps it whole.
const SHOWN_PATH_MAX_CHARS = 80;
const COPIED_LINE_MAX_CHARS = IMPORT_SKIPPED_PATH_MAX_CHARS + 120;

// A limit reads as a round number: 5 MB, not a measured 5.0 MB.
const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

// What a skipped source is, and what to do when there is something to do.
export function skipSentence(reason: SkippedImportSource["reason"], name: string): string {
  switch (reason) {
    case "link":
      return `${name} is a link. Drop the target file instead.`;
    case "not-a-file":
      return `${name} is not a file or folder.`;
    case "unreadable":
      return `dohc could not read ${name}. Check that you can open it, then import it again.`;
    case "workspace-data":
      return `${name} is dohc's own data for a workspace.`;
    case "system-file":
      return `${name} is a system file.`;
    case "left-out":
      return `${name} is excluded from workspaces.`;
    case "dohc-name":
      return `${name} uses a name reserved by dohc. Rename it, then import it.`;
    case "windows-name":
      return `${name} has a name Windows cannot use. Rename it, then import it.`;
    case "name":
      return `dohc cannot save ${name} under that name. Rename it, then import it.`;
    case "too-long":
      return `${name} has a name that is too long to save here. Shorten it, then import it.`;
    case "taken":
      return `${name} and ${IMPORT_COLLISION_RENAMES} numbered copies are already here. Rename it, then import it.`;
    case "no-files":
      return `${name} has no files, and a shared view holds only files.`;
    case "too-large":
      return `${name} exceeds the ${megabytes(MAX_ENGINE_CAPTURE_BINARY_BYTES)} limit for files in a shared view. Make it smaller, then import it.`;
    case "too-large-text":
      return `${name} exceeds the ${megabytes(MAX_ENGINE_CAPTURE_TEXT_BYTES)} limit for text in a shared view. Make it smaller, then import it.`;
  }
}

function shownPath(path: string): string {
  const chars = [...path];
  return chars.length <= SHOWN_PATH_MAX_CHARS
    ? path
    : `…${chars.slice(1 - SHOWN_PATH_MAX_CHARS).join("")}`;
}

const moreLine = (more: number) =>
  more === 1 ? "1 more item was not imported." : `${more} more items were not imported.`;

// One line for each skipped source, as many as a notice holds, and a last
// line counting the rest. Copy names every source the import listed.
export function importSkipLines(
  skipped: number,
  sources: readonly SkippedImportSource[],
): { lines: string[]; lastLine?: string; details: ErrorDetailField[] } {
  const lines: string[] = [];
  let used = 0;
  for (const source of sources) {
    const line = skipSentence(source.reason, shownPath(source.path));
    const needed = (lines.length > 0 ? 1 : 0) + line.length;
    if (used + needed > SHELL_ERROR_MAX_CHARS) break;
    lines.push(line);
    used += needed;
  }
  const rest = lines.length > 0 ? skipped - lines.length : 0;
  const details: ErrorDetailField[] = sources.map(
    (source) =>
      ["Skipped", skipSentence(source.reason, source.path), COPIED_LINE_MAX_CHARS] as const,
  );
  if (skipped > sources.length) details.push(["Skipped", `${skipped - sources.length} more`]);
  return { lines, ...(rest > 0 ? { lastLine: moreLine(rest) } : {}), details };
}
