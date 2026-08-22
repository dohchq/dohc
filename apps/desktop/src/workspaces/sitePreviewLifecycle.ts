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

// requireWorkspace alone only proves a workspaceId is REGISTERED somewhere
// in this app instance, not that it's the one THIS sender's own window is
// currently showing — reading another workspace's site paths, titles,
// diagnostics, or full package-script bodies needs the same active-
// workspace guard startSitePreview/getSitePreviewLogs/stop already apply,
// just for a request that reads instead of starts or stops one.
export function assertActiveWorkspaceForSiteRead(
  activeWorkspaceId: string | undefined,
  workspaceId: string,
): void {
  if (activeWorkspaceId === workspaceId) return;
  throw new Error(
    "The sites request does not target the active workspace. Open the workspace and try again.",
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
  type RunningPreview = {
    state: "running";
    workspaceId: string;
    siteRoot: string;
    handle: SitePreviewHandle;
    releaseOrigin: () => void;
  };
  type ExitedPreview = {
    state: "exited";
    workspaceId: string;
    siteRoot: string;
    handle: SiteProcessHandle;
    logs: SiteLogEntry[];
  };
  type PreviewRecord = RunningPreview | ExitedPreview;
  const activePreviews = new Map<string, PreviewRecord>();

  const markExitedIfCurrent = (
    workspaceId: string,
    siteRoot: string,
    expected: SiteProcessHandle,
  ): void => {
    const key = previewKey(workspaceId, siteRoot);
    const active = activePreviews.get(key);
    if (active?.state !== "running" || active.handle !== expected) return;
    const logs = active.handle.logs().slice(-499);
    logs.push({
      stream: "system",
      text: "Dev server exited unexpectedly.",
      at: Date.now(),
    });
    activePreviews.set(key, {
      state: "exited",
      workspaceId,
      siteRoot,
      handle: active.handle,
      logs,
    });
    active.releaseOrigin();
  };

  return {
    remember(
      workspaceId: string,
      siteRoot: string,
      handle: SitePreviewHandle,
    ): void {
      const key = previewKey(workspaceId, siteRoot);
      const previous = activePreviews.get(key);
      if (previous?.state === "running") previous.releaseOrigin();
      activePreviews.set(key, {
        state: "running",
        workspaceId,
        siteRoot,
        handle,
        releaseOrigin: input.allowOrigin(handle.url),
      });
      if ("onExit" in handle) {
        handle.onExit(() => markExitedIfCurrent(workspaceId, siteRoot, handle));
      }
    },

    isCurrent(
      workspaceId: string,
      siteRoot: string,
      handle: SitePreviewHandle,
    ): boolean {
      const active = activePreviews.get(previewKey(workspaceId, siteRoot));
      return active?.state === "running" && active.handle === handle;
    },

    isRunning(workspaceId: string, siteRoot: string): boolean {
      return activePreviews.get(previewKey(workspaceId, siteRoot))?.state === "running";
    },

    logs(workspaceId: string, siteRoot: string): SiteLogEntry[] {
      const active = activePreviews.get(previewKey(workspaceId, siteRoot));
      if (active?.state === "exited") return [...active.logs];
      return active && "logs" in active.handle ? active.handle.logs() : [];
    },

    exited(
      workspaceId: string,
      siteRoot: string,
      expected?: SitePreviewHandle,
    ): boolean {
      const active = activePreviews.get(previewKey(workspaceId, siteRoot));
      return (
        active?.state === "exited" &&
        (!expected || active.handle === expected)
      );
    },

    // Includes "exited" records too: a wrapper backgrounding its real
    // server and exiting right after reporting the ready URL leaves the
    // RECORD "exited" while the real server (or its captured descendants)
    // can still be running — stop() (below) still needs to reach it, and
    // that only happens if this list doesn't filter it out first.
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
      // Match on handle identity ALONE — requiring state === "running" too
      // made this silently no-op for every exited record whenever a
      // caller pinned the handle it read from previewsForWorkspace()
      // (stopSitePreviewsForWorkspace does exactly that on every workspace
      // switch), even though previewsForWorkspace's own doc comment
      // above says stop() still needs to reach those. An exited record's
      // wrapper is already gone, but handle.stop() (stopChild) still
      // needs to run to reach a descendant it captured while the wrapper
      // was alive.
      if (expected && active?.handle !== expected) return;
      activePreviews.delete(key);
      if (!active) return;
      // An "exited" record's own wrapper process is already gone, but
      // handle.stop() (stopChild) is specifically built to still reach a
      // descendant it captured while the wrapper was alive — skipping it
      // here left a successfully captured background server running
      // forever after the tab, workspace, or app closes. releaseOrigin
      // already ran once, in markExitedIfCurrent, for an exited record —
      // running it again would double-release.
      try {
        await active.handle.stop();
      } finally {
        if (active.state === "running") active.releaseOrigin();
      }
    },

    // Returns its stops' promises rather than firing them and forgetting —
    // the will-quit teardown awaits this (bounded by its own existing stop
    // deadline) so quit cannot outrun a preview process's hard-kill path.
    async stopAll(): Promise<void> {
      const stops: Promise<void>[] = [];
      for (const [key, active] of [...activePreviews]) {
        activePreviews.delete(key);
        if (active.state === "running") active.releaseOrigin();
        stops.push(active.handle.stop().catch(() => undefined));
      }
      await Promise.all(stops);
    },
  };
}
