import type { RendererWorkspaceSession } from "./rendererWorkspaceSessionOwner";

// Whether opening a workspace can reuse this window. The window must show the
// workspace as it is open now: one left showing it from before Forget doesn't
// count, so choosing the folder again opens it.
export function windowShowsWorkspace(
  session: Pick<RendererWorkspaceSession, "workspaceId" | "attachmentId"> | undefined,
  workspaceId: string,
  authorities: { isCurrentAttachment(workspaceId: string, attachmentId: symbol): boolean },
): boolean {
  return session?.workspaceId === workspaceId && authorities.isCurrentAttachment(workspaceId, session.attachmentId);
}
