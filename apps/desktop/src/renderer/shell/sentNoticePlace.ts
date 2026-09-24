import type { NoticeRow, WorkspaceSummary } from "../../ipc/bridgeContract";

// Where Open takes a notice sent to you, on this computer.
export type SentNoticePlace =
  // The notice names no workspace.
  | { kind: "none" }
  // The person can no longer read what the notice named.
  | { kind: "access-ended" }
  // A workspace on this computer, and the notice's file there. `mount` names
  // the shared-with-me folder the file sits in, when the share is one.
  | { kind: "workspace"; workspace: WorkspaceSummary; path: string | null; mount: string | null }
  // A share this computer has not added yet, and the notice's file in it.
  | { kind: "share"; shareId: string; path: string | null }
  // A workspace of the person's that is not on this computer.
  | { kind: "not-here" };

/**
 * Finds a sent notice's target on this computer. A share can be a separate
 * view or a folder in shared-with-me; the current workspace wins, so Open
 * stays where the person is when it can.
 */
export function sentNoticePlace(
  notice: Pick<NoticeRow, "workspaceId" | "recipientShareId" | "target">,
  workspaces: readonly WorkspaceSummary[],
  currentWorkspaceId: string,
): SentNoticePlace {
  if (notice.target === null) return { kind: "access-ended" };
  const path = notice.target.path ?? null;
  if (notice.workspaceId !== null) {
    const workspace = workspaces.find((candidate) => candidate.workspaceId === notice.workspaceId);
    return workspace ? { kind: "workspace", workspace, path, mount: null } : { kind: "not-here" };
  }
  const shareId = notice.recipientShareId;
  if (shareId === null) return { kind: "none" };
  const ordered = [
    ...workspaces.filter((candidate) => candidate.workspaceId === currentWorkspaceId),
    ...workspaces.filter((candidate) => candidate.workspaceId !== currentWorkspaceId),
  ];
  for (const workspace of ordered) {
    if (workspace.shareView?.shareId === shareId) return { kind: "workspace", workspace, path, mount: null };
    const mount = workspace.shareMounts?.find((candidate) => candidate.shareId === shareId);
    if (mount) {
      const folder = `shared-with-me/${mount.label}`;
      return { kind: "workspace", workspace, path: path === null ? null : `${folder}/${path}`, mount: mount.label };
    }
  }
  return { kind: "share", shareId, path };
}

// The folder a notice's file sits in, which names its Collection. A
// collaborator's notice never carries the owner's workspace name, so the
// folder is what tells the person where it came from.
export function sentNoticeFolder(notice: Pick<NoticeRow, "target">): string | null {
  return notice.target?.path?.split("/").at(-2) ?? null;
}
