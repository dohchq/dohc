/**
 * Files, or messages, opened from outside dohc, each waiting for its window to
 * show its workspace. A renderer that has opened a workspace's session is
 * listening, so an open goes then, never into a page that is still loading. A
 * window keeps only its latest open, and opening any workspace there settles it.
 */
export function createWorkspaceFileOpens<Contents extends object, Workspace extends { workspaceId: string }, Open = string>(deps: {
  shownWorkspaceId(contents: Contents): string | undefined;
  send(contents: Contents, workspace: Workspace, open: Open): void;
}) {
  const waiting = new WeakMap<Contents, { workspace: Workspace; open: Open }>();
  return {
    request(contents: Contents, workspace: Workspace, open: Open): void {
      if (deps.shownWorkspaceId(contents) !== workspace.workspaceId) {
        waiting.set(contents, { workspace, open });
        return;
      }
      waiting.delete(contents);
      deps.send(contents, workspace, open);
    },
    shown(contents: Contents, workspaceId: string): void {
      const request = waiting.get(contents);
      if (!request) return;
      waiting.delete(contents);
      if (request.workspace.workspaceId === workspaceId) deps.send(contents, request.workspace, request.open);
    },
  };
}
