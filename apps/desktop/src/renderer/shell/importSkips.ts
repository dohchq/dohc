import type { SkippedImportSource } from "../../ipc/bridgeContract";
import {
  formatSize,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "../../workspaces/workspaceEngineCaptureLimits";
import type { ErrorDetailField } from "./copyDetails";
import { SHELL_ERROR_MAX_CHARS } from "./useShellError";

// A path from a drop can run to 4096 characters. A line shows its end, where
// the file's name is; Copy keeps it whole.
const SHOWN_PATH_MAX_CHARS = 80;
const COPIED_LINE_MAX_CHARS = 4096 + 120;

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
      return `${name} is a name dohc leaves out of workspaces.`;
    case "dohc-name":
      return `${name} is a name dohc keeps for itself. Rename it, then import it.`;
    case "windows-name":
      return `${name} has a name Windows can't use. Rename it, then import it.`;
    case "name":
      return `${name} has a name dohc can't save as it is. Rename it, then import it.`;
    case "too-long":
      return `${name} has a name too long to save here. Shorten it, then import it.`;
    case "taken":
      return `${name} and 99 numbered copies of it are already here. Rename it, then import it.`;
    case "no-files":
      return `${name} has no files, and a shared view holds only files.`;
    case "too-large":
      return `${name} is larger than a shared view's ${formatSize(MAX_ENGINE_CAPTURE_BINARY_BYTES)} limit.`;
    case "too-large-text":
      return `${name} is larger than a shared view's ${formatSize(MAX_ENGINE_CAPTURE_TEXT_BYTES)} limit for text.`;
  }
}

function shownPath(path: string): string {
  const chars = [...path];
  return chars.length <= SHOWN_PATH_MAX_CHARS ? path : `…${chars.slice(1 - SHOWN_PATH_MAX_CHARS).join("")}`;
}

const moreLine = (more: number) => `${more} more weren't imported.`;

// One line for each skipped source, as many as a notice holds, then a count
// of the rest. Copy names every source the import listed.
export function importSkipLines(
  skipped: number,
  sources: readonly SkippedImportSource[],
): { lines: string[]; details: ErrorDetailField[] } {
  const lines: string[] = [];
  let used = 0;
  for (const source of sources) {
    const line = skipSentence(source.reason, shownPath(source.path));
    const rest = skipped - lines.length - 1;
    const needed = (lines.length > 0 ? 1 : 0) + line.length + (rest > 0 ? 1 + moreLine(rest).length : 0);
    if (used + needed > SHELL_ERROR_MAX_CHARS) break;
    lines.push(line);
    used += (lines.length > 1 ? 1 : 0) + line.length;
  }
  if (lines.length > 0 && skipped > lines.length) lines.push(moreLine(skipped - lines.length));
  const details: ErrorDetailField[] = sources.map((source) =>
    ["Skipped", skipSentence(source.reason, source.path), COPIED_LINE_MAX_CHARS] as const);
  if (skipped > sources.length) details.push(["Skipped", `${skipped - sources.length} more`]);
  return { lines, details };
}
