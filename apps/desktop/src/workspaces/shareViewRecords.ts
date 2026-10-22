import {
  isShareAccessValue,
  isShareablePathList,
  isValidShareVersionId,
} from "@dohc/security-contract/share-selector";
import type { ShareViewSelector } from "./shareViewInfo";
import {
  formatSize,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "./workspaceEngineCaptureLimits";

export interface UnjournalablePath {
  path: string;
  reason:
    | "oversized-text"
    | "oversized-binary"
    | "non-utf8"
    | "non-file-replacement"
    | "local-collision"
    | "spelling-collision"
    | "unreadable";
  // For a spelling collision, the shared spelling whose file this one reaches.
  owner?: string;
}

function namedPaths(paths: readonly UnjournalablePath[]): string {
  const named = paths
    .slice(0, 3)
    .map((entry) => entry.path)
    .join(", ");
  return paths.length > 3 ? `${named}, and ${paths.length - 3} more` : named;
}

export function unjournalablePathMessages(
  paths: readonly UnjournalablePath[],
): string[] {
  const groups = new Map<UnjournalablePath["reason"], UnjournalablePath[]>();
  for (const path of paths) {
    const group = groups.get(path.reason) ?? [];
    group.push(path);
    groups.set(path.reason, group);
  }
  const messages: string[] = [];
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
    const names = namedPaths(group);
    const one = group.length === 1;
    if (reason === "oversized-text") {
      messages.push(
        `${names} ${one ? "is" : "are"} larger than the ${formatSize(MAX_ENGINE_CAPTURE_TEXT_BYTES)} text limit. ` +
          `Make ${one ? "this file" : "these files"} smaller.`,
      );
    } else if (reason === "oversized-binary") {
      messages.push(
        `${names} ${one ? "is" : "are"} larger than the ${formatSize(MAX_ENGINE_CAPTURE_BINARY_BYTES)} binary limit. ` +
          `Make ${one ? "this file" : "these files"} smaller.`,
      );
    } else if (reason === "non-utf8") {
      messages.push(
        `${names} ${one ? "is" : "are"} not readable as text. ` +
          `Save ${one ? "this file" : "these files"} as UTF-8 text.`,
      );
    } else if (reason === "non-file-replacement") {
      messages.push(
        `${names} ${one ? "replaces a tracked file" : "replace tracked files"} with a folder or another entry. ` +
          `Restore ${one ? "the file" : "the files"} or move ${one ? "the conflicting entry" : "the conflicting entries"}.`,
      );
    } else if (reason === "local-collision") {
      messages.push(
        `${names} ${one ? "already has a file" : "already have files"} from this machine. ` +
          `Move or remove ${one ? "this file" : "these files"} to receive the shared ${one ? "file" : "files"}.`,
      );
    } else if (reason === "spelling-collision") {
      const owner = one ? group[0]!.owner : undefined;
      messages.push(
        owner === undefined
          ? `This machine treats ${names} each as the same name as another shared file. Ask the person who shared the files to rename them.`
          : `This machine treats ${names} and ${owner} as the same name. Ask the person who shared the files to rename one of them.`,
      );
    } else {
      messages.push(
        `dohc could not read ${names}. ` +
          `Close anything using ${one ? "this file" : "these files"}, or wait.`,
      );
    }
  }
  return messages;
}

// A spelling collision holds nothing of this machine's, so it never stops
// changes from being sent.
export function assertShareChangesJournalable(
  unjournalable: readonly UnjournalablePath[],
): void {
  const paths = unjournalable.filter((path) => path.reason !== "spelling-collision");
  if (paths.length === 0) return;
  const one = paths.length === 1;
  throw new Error(
    `dohc did not send your changes. ${unjournalablePathMessages(paths).join(" ")} ` +
      `Fix ${one ? "this file" : "these files"}, then send your changes again.`,
  );
}

// A held spelling's file is the file of the spelling that owns it, so saving,
// moving or deleting the held one would write over the owner's (#2416).
export function assertHeldSpellingsUnchanged(
  unjournalable: readonly UnjournalablePath[],
): void {
  const held = unjournalable.filter((path) => path.reason === "spelling-collision");
  if (held.length === 0) return;
  throw new Error(
    `dohc did not change ${namedPaths(held)}. ${unjournalablePathMessages(held).join(" ")}`,
  );
}

export class SharePinInvalidError extends Error {
  constructor(readonly shareId: string) {
    super(
      `Share ${shareId} has no readable pinned selector; ` +
        "its record is damaged and the share must be added again.",
    );
    this.name = "SharePinInvalidError";
  }
}

export function recordedShareSelector(
  value: unknown,
): ShareViewSelector | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as {
    paths?: unknown;
    versionId?: unknown;
    access?: unknown;
  };
  if (!Array.isArray(candidate.paths)) return null;
  if (!isShareablePathList(candidate.paths)) return null;
  if (
    candidate.versionId !== null &&
    !isValidShareVersionId(candidate.versionId)
  ) {
    return null;
  }
  if (candidate.paths.length === 0 && candidate.versionId === null) return null;
  if (!isShareAccessValue(candidate.access)) return null;
  return {
    paths: [...(candidate.paths as string[])],
    versionId: isValidShareVersionId(candidate.versionId)
      ? candidate.versionId
      : null,
    access: candidate.access,
  };
}

export function shareViewIdentitySelector(input: {
  shareView:
    | {
        grantedSelector?: unknown;
        ended?: boolean;
        relayUrl?: string | null;
      }
    | null
    | undefined;
  relayUrl: string | null | undefined;
  relayUrlsMatch: (left: string, right: string) => boolean;
}): ShareViewSelector | null {
  const { shareView, relayUrl, relayUrlsMatch } = input;
  if (!shareView || shareView.ended === true) return null;
  const grantedSelector = recordedShareSelector(shareView.grantedSelector);
  if (!grantedSelector) return null;
  if (grantedSelector.access !== "edit") return null;
  if (!relayUrl) return null;
  if (shareView.relayUrl && !relayUrlsMatch(relayUrl, shareView.relayUrl)) {
    return null;
  }
  return grantedSelector;
}
