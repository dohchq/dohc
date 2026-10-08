import type { ShareUnconfirmedChanges } from "./shareViewInfo";

export function shareCaptureNoticeState(paths: readonly string[] | null | undefined,
  snapshot: ShareUnconfirmedChanges | undefined, ended: boolean) {
  const filePaths = [...new Set([...(paths ?? []), ...(snapshot?.paths ?? [])])].sort();
  const unchecked = paths === null || snapshot?.unchecked === true;
  const checked = snapshot?.checked ?? 0;
  const key = JSON.stringify({ paths: filePaths, unchecked, checked, ended });
  return { filePaths, unchecked, checked, key };
}
