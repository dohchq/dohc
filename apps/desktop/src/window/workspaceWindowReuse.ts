// Whether this window shows the workspace as it is open now. A window left
// showing it from before Forget doesn't: choosing the folder again opens it in
// a new window, and the old one isn't another window showing it.
export function windowShowsWorkspace(
  session: { readonly workspaceId: string; readonly attachmentId: symbol } | undefined,
  workspaceId: string,
  authorities: { isCurrentAttachment(workspaceId: string, attachmentId: symbol): boolean },
): boolean {
  return session?.workspaceId === workspaceId && authorities.isCurrentAttachment(workspaceId, session.attachmentId);
}
