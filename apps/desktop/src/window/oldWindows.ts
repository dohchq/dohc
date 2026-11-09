import { CHANNELS } from "../ipc/channels";
import type { OldWindowState } from "../ipc/bridgeContract";
import { oldWindowState } from "./workspaceWindowReuse";

interface WindowContents {
  isDestroyed(): boolean;
  send(channel: string): void;
}

// Windows Forget left showing a workspace. Each answer comes from the asking
// window's own session; the renderer names no workspace or window.
export function createOldWindows<
  Contents extends WindowContents,
  Window extends { readonly webContents: Contents },
>(dependencies: {
  windows(): readonly Window[];
  sessionOf(contents: Contents): { readonly workspaceId: string; readonly attachmentId: symbol } | undefined;
  authorities: { isCurrentAttachment(workspaceId: string, attachmentId: symbol): boolean };
  // Quitting closes every workspace, which leaves no window old.
  isQuitting(): boolean;
  // Brings a window to the front. Never opens one.
  focus(window: Window): void;
}) {
  function oldWindowOf(contents: Contents) {
    if (dependencies.isQuitting()) return null;
    return oldWindowState(
      dependencies.sessionOf(contents),
      dependencies.windows().filter(window => window.webContents !== contents),
      window => dependencies.sessionOf(window.webContents),
      dependencies.authorities,
    );
  }

  return {
    read(contents: Contents): OldWindowState {
      const old = oldWindowOf(contents);
      return old && { workspaceId: old.workspaceId, openElsewhere: old.shownIn !== undefined };
    },
    // Does nothing unless another window shows this window's workspace.
    goTo(contents: Contents): void {
      const shownIn = oldWindowOf(contents)?.shownIn;
      if (shownIn) dependencies.focus(shownIn);
    },
    // A window opened or left a workspace: each old window reads its state again.
    notify(): void {
      for (const window of dependencies.windows()) {
        if (!window.webContents.isDestroyed() && oldWindowOf(window.webContents) !== null) {
          window.webContents.send(CHANNELS.oldWindowStateChanged);
        }
      }
    },
  };
}
