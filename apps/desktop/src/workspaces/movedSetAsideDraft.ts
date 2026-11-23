import {
  projectTreePath,
  type PendingTreeChange,
} from "../renderer/workbench/file-tree-optimistic";

export const SET_ASIDE_DRAFT_VERSION = 1;

export function movedSetAsideDraft(
  raw: string,
  workspaceId: string,
  changes: readonly PendingTreeChange[],
): { path: string; raw: string } | null {
  let row: unknown;
  try {
    row = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof row !== "object" ||
    row === null ||
    !("workspaceId" in row) ||
    row.workspaceId !== workspaceId ||
    !("path" in row) ||
    typeof row.path !== "string" ||
    ("version" in row && row.version !== SET_ASIDE_DRAFT_VERSION)
  )
    return null;
  const path = projectTreePath(row.path, changes);
  if (path === null || path === row.path) return null;
  return { path, raw: JSON.stringify({ ...row, path, version: SET_ASIDE_DRAFT_VERSION }) };
}
