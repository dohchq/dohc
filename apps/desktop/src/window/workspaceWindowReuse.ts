type WindowSession = { readonly workspaceId: string; readonly attachmentId: symbol };
type Authorities = { isCurrentAttachment(workspaceId: string, attachmentId: symbol): boolean };

// Whether this window shows the workspace as it is open now. A window left
// showing it from before Forget doesn't: choosing the folder again opens it in
// a new window, and the old one isn't another window showing it.
export function windowShowsWorkspace(
  session: WindowSession | undefined,
  workspaceId: string,
  authorities: Authorities,
): boolean {
  return session?.workspaceId === workspaceId && authorities.isCurrentAttachment(workspaceId, session.attachmentId);
}

// A window's session while it shows its workspace as it is open now. A window
// left from before Forget has none, so what main tells the workspace's window,
// such as a change that couldn't be saved, reaches the new window instead.
export function currentWindowSession<Session extends WindowSession>(
  session: Session | undefined,
  authorities: Authorities,
): Session | undefined {
  return session && windowShowsWorkspace(session, session.workspaceId, authorities) ? session : undefined;
}

// A window left showing a workspace from before Forget: the workspace, and the
// other window that shows it now, if any. Null while the window shows its
// workspace as it is open now, or shows none.
export function oldWindowState<Window>(
  session: WindowSession | undefined,
  otherWindows: readonly Window[],
  sessionOf: (window: Window) => WindowSession | undefined,
  authorities: Authorities,
): { workspaceId: string; shownIn: Window | undefined } | null {
  if (session === undefined || windowShowsWorkspace(session, session.workspaceId, authorities)) return null;
  return {
    workspaceId: session.workspaceId,
    shownIn: otherWindows.find(other => windowShowsWorkspace(sessionOf(other), session.workspaceId, authorities)),
  };
}
