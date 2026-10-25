import type { SkippedImportSource } from "../../ipc/bridgeContract";
import { IMPORT_COLLISION_RENAMES, IMPORT_SKIPPED_PATH_MAX_CHARS } from "../../ipc/channels";
import {
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "../../workspaces/workspaceEngineCaptureLimits";
import type { ErrorDetailField } from "./copyDetails";
import { SHELL_ERROR_MAX_CHARS } from "./useShellError";

// A path from a drop can run to 32,767 characters. A line shows its end, where
// the file's name is; Copy keeps it whole.
const SHOWN_PATH_MAX_CHARS = 80;
const COPIED_LINE_MAX_CHARS = IMPORT_SKIPPED_PATH_MAX_CHARS + 120;

// A limit reads as a round number: 5 MB, not a measured 5.0 MB.
const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

// What a skipped source is, and what to do when there is something to do.
export function skipSentence(reason: SkippedImportSource["reason"], name: string): string {
  switch (reason) {
    case "link":
      return `${name} is a link. Drop the file it leads to.`;
    case "not-a-file":
      return `${name} isn't a file or a folder.`;
    case "unreadable":
      return `${name} couldn't be read. Check that you can open it, then import it again.`;
    case "workspace-data":
      return `${name} is dohc's own data for a workspace.`;
    case "system-file":
      return `${name} is a file the system makes.`;
    case "left-out":
      return `${name} is left out of every workspace.`;
    case "dohc-name":
      return `${name} is a name dohc keeps for itself. Rename it, then import it.`;
    case "windows-name":
      return `${name} has a name Windows can't use. Rename it, then import it.`;
    case "name":
      return `${name} can't be saved under that name. Rename it, then import it.`;
    case "too-long":
      return `${name} has a name too long to save here. Shorten it, then import it.`;
    case "taken":
      return `${name} and ${IMPORT_COLLISION_RENAMES} numbered copies are already here. Rename it, then import it.`;
    case "no-files":
      return `${name} has no files, and a shared view holds only files.`;
    case "too-large":
      return `${name} is over the ${megabytes(MAX_ENGINE_CAPTURE_BINARY_BYTES)} limit for files in a shared view. Make it smaller, then import it.`;
    case "too-large-text":
      return `${name} is over the ${megabytes(MAX_ENGINE_CAPTURE_TEXT_BYTES)} limit for text in a shared view. Make it smaller, then import it.`;
  }
}

function shownPath(path: string): string {
  const chars = [...path];
  return chars.length <= SHOWN_PATH_MAX_CHARS ? path : `…${chars.slice(1 - SHOWN_PATH_MAX_CHARS).join("")}`;
}

const moreLine = (more: number) => `${more} more weren't imported.`;

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
  const details: ErrorDetailField[] = sources.map((source) =>
    ["Skipped", skipSentence(source.reason, source.path), COPIED_LINE_MAX_CHARS] as const);
  if (skipped > sources.length) details.push(["Skipped", `${skipped - sources.length} more`]);
  return { lines, ...(rest > 0 ? { lastLine: moreLine(rest) } : {}), details };
}
