import type { SiteProcessHandle, StaticSitePreview } from "./siteRunner";

export type SitePreviewHandle = StaticSitePreview | SiteProcessHandle;

export function assertActiveWorkspaceForSitePreviewStop(
  activeWorkspaceId: string | undefined,
  workspaceId: string,
): void {
  if (activeWorkspaceId === workspaceId) return;
  throw new Error(
    "The Site preview request does not target the active workspace. Open the workspace and stop the preview again.",
  );
}

export async function stopSitePreviewForActiveWorkspace(input: {
  activeWorkspaceId: () => string | undefined;
  workspaceId: string;
  stop: () => Promise<void>;
}): Promise<void> {
  assertActiveWorkspaceForSitePreviewStop(
    input.activeWorkspaceId(),
    input.workspaceId,
  );
  await input.stop();
}

function previewKey(workspaceId: string, siteRoot: string): string {
  return `${workspaceId}\0${siteRoot}`;
}

export function createSitePreviewLifecycle(input: {
  allowOrigin: (url: string) => () => void;
}) {
  type ActivePreview = {
    workspaceId: string;
    siteRoot: string;
    handle: SitePreviewHandle;
    releaseOrigin: () => void;
  };
  const activePreviews = new Map<string, ActivePreview>();

  const removeIfCurrent = (
    workspaceId: string,
    siteRoot: string,
    expected: SitePreviewHandle,
  ): void => {
    const key = previewKey(workspaceId, siteRoot);
    const active = activePreviews.get(key);
    if (active?.handle !== expected) return;
    activePreviews.delete(key);
    active.releaseOrigin();
  };

  return {
    remember(
      workspaceId: string,
      siteRoot: string,
      handle: SitePreviewHandle,
    ): void {
      const key = previewKey(workspaceId, siteRoot);
      activePreviews.get(key)?.releaseOrigin();
      activePreviews.set(key, {
        workspaceId,
        siteRoot,
        handle,
        releaseOrigin: input.allowOrigin(handle.url),
      });
      if ("onExit" in handle) {
        handle.onExit(() => removeIfCurrent(workspaceId, siteRoot, handle));
      }
    },

    isCurrent(
      workspaceId: string,
      siteRoot: string,
      handle: SitePreviewHandle,
    ): boolean {
      return activePreviews.get(previewKey(workspaceId, siteRoot))?.handle === handle;
    },

    isRunning(workspaceId: string, siteRoot: string): boolean {
      return activePreviews.has(previewKey(workspaceId, siteRoot));
    },

    previewsForWorkspace(
      workspaceId: string,
    ): Array<{ siteRoot: string; handle: SitePreviewHandle }> {
      return [...activePreviews.values()]
        .filter((active) => active.workspaceId === workspaceId)
        .map(({ siteRoot, handle }) => ({ siteRoot, handle }));
    },

    async stop(
      workspaceId: string,
      siteRoot: string,
      expected?: SitePreviewHandle,
    ): Promise<void> {
      const key = previewKey(workspaceId, siteRoot);
      const active = activePreviews.get(key);
      if (expected && active?.handle !== expected) return;
      activePreviews.delete(key);
      if (!active) return;
      try {
        await active.handle.stop();
      } finally {
        active.releaseOrigin();
      }
    },

    stopAll(): void {
      for (const [key, active] of [...activePreviews]) {
        activePreviews.delete(key);
        active.releaseOrigin();
        void active.handle.stop().catch(() => undefined);
      }
    },
  };
}
