export interface OpenPathFailureWindow {
  isDestroyed(): boolean;
  on(event: "closed", listener: () => void): unknown;
  off(event: "closed", listener: () => void): unknown;
  webContents: {
    isDestroyed(): boolean;
    isCrashed(): boolean;
    isLoadingMainFrame(): boolean;
    getURL(): string;
    on(event: "did-finish-load" | "did-stop-loading", listener: () => void): unknown;
    on(event: "destroyed" | "render-process-gone", listener: () => void): unknown;
    on(event: "did-fail-load", listener: (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void): unknown;
    off(event: "did-finish-load" | "did-stop-loading", listener: () => void): unknown;
    off(event: "destroyed" | "render-process-gone", listener: () => void): unknown;
    off(event: "did-fail-load", listener: (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void): unknown;
  };
}

// Separate from startup's load handling: open-failure reports and menu
// commands also reach an already-loaded renderer, and a window that closes
// while loading. The main frame still counts as loading between
// did-finish-load and did-stop-loading, so either event means ready.
export function whenRendererReady(window: OpenPathFailureWindow): Promise<boolean> {
  const contents = window.webContents;
  if (window.isDestroyed() || contents.isDestroyed() || contents.isCrashed()) return Promise.resolve(false);
  if (contents.getURL() && !contents.isLoadingMainFrame()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const settle = (ready: boolean) => {
      contents.off("did-finish-load", onLoad);
      contents.off("did-stop-loading", onLoad);
      contents.off("did-fail-load", onFail);
      window.off("closed", onClosed);
      contents.off("destroyed", onClosed);
      contents.off("render-process-gone", onClosed);
      resolve(ready);
    };
    const onLoad = () => settle(true);
    const onClosed = () => settle(false);
    const onFail = (_event: unknown, code: number, _description: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame && code !== -3) settle(false);
    };
    contents.on("did-finish-load", onLoad);
    contents.on("did-stop-loading", onLoad);
    contents.on("did-fail-load", onFail);
    window.on("closed", onClosed);
    contents.on("destroyed", onClosed);
    contents.on("render-process-gone", onClosed);
  });
}

export function captureOpenPathFailureTarget<Session extends { workspaceId: string }>(
  window: OpenPathFailureWindow,
  context: { isLive(): boolean; currentSession(): Session | undefined; admittedCount(): number },
) {
  const session = context.currentSession();
  const admitted = context.admittedCount();
  const ready = whenRendererReady(window);
  return {
    whenReady: () => ready,
    isCurrent: (opened?: { workspaceId: string } | null) => {
      if (!context.isLive() || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()) return false;
      const current = context.currentSession();
      // A window with no workspace yet that then opens its first one, such
      // as a starting window opening its first listed workspace, has not
      // switched away from the request.
      const first = session === undefined && current !== undefined && context.admittedCount() === admitted + 1;
      return current === session || first || (opened != null && current?.workspaceId === opened.workspaceId);
    },
  };
}
