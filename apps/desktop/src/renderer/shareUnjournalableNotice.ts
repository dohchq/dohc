import type { RefreshSharedViewResult } from "../ipc/bridgeContract";
import type { ErrorDetailField } from "./shell/copyDetails";
import {
  formatSize,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "../workspaces/workspaceEngineCaptureLimits";

export type UnjournalableSharePath = Extract<
  RefreshSharedViewResult,
  { ok: true }
>["unjournalablePaths"][number];

function sharedFiles(count: number): string {
  return count === 1 ? "a shared file" : `${count} shared files`;
}

export function shareNoticePaths(paths: readonly UnjournalableSharePath[]): string[] {
  return [...new Set(paths.flatMap(entry => entry.owner === undefined
    ? [entry.path]
    : entry.reason === "local-collision" ? [entry.owner, entry.path] : [entry.path, entry.owner]))];
}

// A Notices row's title. The row lists the paths under its text, so it
// shows the text whole: each reason and next step.
export function shareUnjournalableTitle(paths: readonly UnjournalableSharePath[], label: string): string {
  return `dohc skipped ${sharedFiles(new Set(paths.map(entry => entry.path)).size)} from ${label}`;
}

export function shareUnjournalableNotice(paths: readonly UnjournalableSharePath[]): string {
  return shareUnjournalableLines(paths).join(" ");
}

// A Notices row's text, as many whole reasons as `budget` holds, then a
// count of the rest. Details holds every reason when some are left out.
export function shareUnjournalableRow(
  paths: readonly UnjournalableSharePath[],
  budget: number,
): { message: string; details: ErrorDetailField[] } {
  const lines = shareUnjournalableLines(paths);
  const text = (shown: readonly string[]) => {
    const rest = lines.length - shown.length;
    return [...shown, ...(rest > 0 ? [`Details has ${rest === 1 ? "1 more reason" : `${rest} more reasons`}.`] : [])].join(" ");
  };
  const shown: string[] = [];
  for (const line of lines) {
    if ([...text([...shown, line])].length > budget) break;
    shown.push(line);
  }
  return {
    message: text(shown),
    details: shown.length < lines.length ? lines.map(line => ["Reason", line] as const) : [],
  };
}

function shareUnjournalableLines(paths: readonly UnjournalableSharePath[]): string[] {
  const groups = new Map<
    UnjournalableSharePath["reason"],
    UnjournalableSharePath[]
  >();
  for (const path of paths) {
    const group = groups.get(path.reason) ?? [];
    group.push(path);
    groups.set(path.reason, group);
  }
  const lines: string[] = [];
  for (const reason of [
    "oversized-text",
    "oversized-binary",
    "non-utf8",
    "non-file-replacement",
    "local-collision",
    "spelling-collision",
    "unreadable",
  ] as const) {
    const group = groups.get(reason);
    if (!group || group.length === 0) continue;
    // Each line names no path, so the clamp cuts no reason or next step.
    // The notice lists the paths under it.
    const files = sharedFiles(group.length);
    const one = group.length === 1;
    if (reason === "oversized-text" || reason === "oversized-binary") {
      const limit = reason === "oversized-text"
        ? `${formatSize(MAX_ENGINE_CAPTURE_TEXT_BYTES)} text`
        : `${formatSize(MAX_ENGINE_CAPTURE_BINARY_BYTES)} binary`;
      lines.push(
        `dohc could not track changes in ${files}. ` +
          `${one ? "It is" : "They are"} larger than the ${limit} limit. ` +
          `Make ${one ? "it" : "them"} smaller, then refresh.`,
      );
    } else if (reason === "non-utf8") {
      lines.push(
        `dohc could not track changes in ${files}. ` +
          `${one ? "It is" : "They are"} not readable as text. ` +
          `Save ${one ? "it" : "them"} as UTF-8 text, then refresh.`,
      );
    } else if (reason === "non-file-replacement") {
      lines.push(
        `dohc could not track changes in ${files}. ` +
          `${one ? "A folder or another entry replaces it" : "Folders or other entries replace them"}. ` +
          `Restore ${one ? "the file" : "the files"} or move ${one ? "the conflicting entry" : "the conflicting entries"}, then refresh.`,
      );
    } else if (reason === "local-collision") {
      const yours = new Set(group.map(entry => entry.owner ?? entry.path)).size === 1;
      lines.push(
        `dohc could not receive ${files}. ` +
          `${yours ? "A file from this machine is in the way" : "Files from this machine are in the way"}. ` +
          `Move or rename ${yours ? "your file" : "your files"}, then refresh.`,
      );
    } else if (reason === "spelling-collision") {
      lines.push(
        `dohc could not receive ${files}. ` +
          (one && group[0]!.owner !== undefined
            ? "This machine treats its name and another shared file's as the same name. Ask the person who shared the files to rename one of them."
            : "This machine treats each name as the same as another shared file's. Ask the person who shared the files to rename them."),
      );
    } else {
      lines.push(
        `dohc could not read ${files}. ` +
          `Close anything using ${one ? "it" : "them"}, or wait, then refresh.`,
      );
    }
  }
  return lines;
}
