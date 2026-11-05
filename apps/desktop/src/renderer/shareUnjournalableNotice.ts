import type { RefreshSharedViewResult } from "../ipc/bridgeContract";
import {
  formatSize,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "../workspaces/workspaceEngineCaptureLimits";

export type UnjournalableSharePath = Extract<
  RefreshSharedViewResult,
  { ok: true }
>["unjournalablePaths"][number];

function namedUnjournalablePaths(paths: readonly UnjournalableSharePath[]): string {
  const named = paths.slice(0, 3).map((entry) => entry.path).join(", ");
  return paths.length > 3 ? `${named}, and ${paths.length - 3} more` : named;
}

export function shareNoticePaths(paths: readonly UnjournalableSharePath[]): string[] {
  return [...new Set(paths.flatMap(entry => entry.owner === undefined
    ? [entry.path]
    : entry.reason === "local-collision" ? [entry.owner, entry.path] : [entry.path, entry.owner]))];
}

export function shareUnjournalableNotice(
  paths: readonly UnjournalableSharePath[],
): string {
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
    const shown = reason === "local-collision"
      ? [...new Set(group.map(entry => entry.owner ?? entry.path))].map(path => ({ path, reason }))
      : group;
    const names = namedUnjournalablePaths(shown);
    const one = shown.length === 1;
    if (reason === "oversized-text") {
      lines.push(
        `dohc could not track changes in ${names}. ` +
          `${one ? "This file is" : "These files are"} larger than the ${formatSize(MAX_ENGINE_CAPTURE_TEXT_BYTES)} text limit. ` +
          `Make ${one ? "the file" : "the files"} smaller, then refresh.`,
      );
    } else if (reason === "oversized-binary") {
      lines.push(
        `dohc could not track changes in ${names}. ` +
          `${one ? "This file is" : "These files are"} larger than the ${formatSize(MAX_ENGINE_CAPTURE_BINARY_BYTES)} binary limit. ` +
          `Make ${one ? "the file" : "the files"} smaller, then refresh.`,
      );
    } else if (reason === "non-utf8") {
      lines.push(
        `dohc could not track changes in ${names}. ` +
          `${one ? "This file is" : "These files are"} not readable as text. ` +
          `Save ${one ? "the file" : "the files"} as UTF-8 text, then refresh.`,
      );
    } else if (reason === "non-file-replacement") {
      lines.push(
        `dohc could not track changes in ${names}. ` +
          `${one ? "A folder or another entry replaces this file" : "Folders or other entries replace these files"}. ` +
          `Restore ${one ? "the file" : "the files"} or move ${one ? "the conflicting entry" : "the conflicting entries"}, then refresh.`,
      );
    } else if (reason === "local-collision") {
      lines.push(
        `dohc could not receive ${names}. ` +
          `${one ? "A file from this machine already uses this path" : "Files from this machine already use these paths"}. ` +
          `Move or rename ${one ? "the file" : "the files"}, then refresh.`,
      );
    } else if (reason === "spelling-collision") {
      const owner = one ? group[0]!.owner : undefined;
      lines.push(
        `dohc could not receive ${names}. ` +
          (owner === undefined
            ? "This machine treats each name as the same as another shared file's. Ask the person who shared the files to rename them."
            : `This machine treats ${names} and ${owner} as the same name. Ask the person who shared the files to rename one of them.`),
      );
    } else {
      lines.push(
        `dohc could not read ${names}. ` +
          `Close anything using ${one ? "the file" : "the files"}, or wait, then refresh.`,
      );
    }
  }
  return lines.join(" ");
}
