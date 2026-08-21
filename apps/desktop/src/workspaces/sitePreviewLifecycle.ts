import type {
  SiteLogEntry,
  SiteProcessHandle,
  StaticSitePreview,
} from "./siteRunner";

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

function previewKey(workspaceId: string, siteRoot: string): string {
  return `${workspaceId}\0${siteRoot}`;
}

export function createSitePreviewStartRegistry() {
  type PendingStart = {
    senderId: number;
    siteKey: string;
    controller: AbortController;
  };
  const startsBySender = new Map<number, Set<PendingStart>>();
  const startsBySite = new Map<string, Set<PendingStart>>();

  const remove = (start: PendingStart): void => {
    const senderStarts = startsBySender.get(start.senderId);
    senderStarts?.delete(start);
    if (senderStarts?.size === 0) startsBySender.delete(start.senderId);

    const siteStarts = startsBySite.get(start.siteKey);
    siteStarts?.delete(start);
    if (siteStarts?.size === 0) startsBySite.delete(start.siteKey);
  };

  const abort = (starts: Iterable<PendingStart>): void => {
    for (const start of [...starts]) {
      remove(start);
      start.controller.abort();
    }
  };

  return {
    begin(senderId: number, workspaceId: string, siteRoot: string) {
      const start: PendingStart = {
        senderId,
        siteKey: previewKey(workspaceId, siteRoot),
        controller: new AbortController(),
      };
      const senderStarts = startsBySender.get(senderId) ?? new Set<PendingStart>();
      senderStarts.add(start);
      startsBySender.set(senderId, senderStarts);
      const siteStarts = startsBySite.get(start.siteKey) ?? new Set<PendingStart>();
      siteStarts.add(start);
      startsBySite.set(start.siteKey, siteStarts);
      return {
        controller: start.controller,
        finish: () => remove(start),
      };
    },

    abortForSender(senderId: number): void {
      abort(startsBySender.get(senderId) ?? []);
    },

    abortForSite(workspaceId: string, siteRoot: string): void {
      abort(startsBySite.get(previewKey(workspaceId, siteRoot)) ?? []);
    },
  };
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

    logs(workspaceId: string, siteRoot: string): SiteLogEntry[] {
      const handle =
        activePreviews.get(previewKey(workspaceId, siteRoot))?.handle;
      return handle && "logs" in handle ? handle.logs() : [];
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
