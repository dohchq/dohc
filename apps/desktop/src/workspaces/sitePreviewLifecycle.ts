import {
  MAX_LOG_ENTRIES,
  type SiteLogEntry,
  type SiteProcessHandle,
  type StaticSitePreview,
} from "./siteRunner";

export type SitePreviewHandle = StaticSitePreview | SiteProcessHandle;

// requireWorkspace alone only proves a workspaceId is REGISTERED somewhere
// in this app instance, not that it's the one THIS sender's own window is
// currently showing — every site-preview and sites-read IPC handler needs
// the same active-workspace guard, naming what it was trying to do (subject)
// and what the user should do about it (action) so the message stays
// specific to the request that actually failed instead of a generic "try
// again" that doesn't say what "again" even means for a stop request. Both
// interpolations share one register — plain, lowercase noun phrases that
// read naturally mid-sentence ("The sites request does not target...", not
// "The Sites request...").
export function assertActiveWorkspaceForSite(
  activeWorkspaceId: string | undefined,
  workspaceId: string,
  subject: string,
  action = "try again",
): void {
  if (activeWorkspaceId === workspaceId) return;
  throw new Error(
    `The ${subject} does not target the active workspace. Open the workspace and ${action}.`,
  );
}

function previewKey(workspaceId: string, siteRoot: string): string {
  return `${workspaceId}\0${siteRoot}`;
}

// One less than siteRunner's own MAX_LOG_ENTRIES — see the comment where
// this is used.
const EXITED_LOG_ENTRY_BUDGET = MAX_LOG_ENTRIES - 1;

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

// The queued-lock algorithm itself is app-wide — main.ts reuses the exact
// same shape for plugin panel/web-app/host-lifecycle locks too, each with
// its own Map — so it's exported from here as the ONE implementation
// instead of main.ts keeping a second, independently-drifting copy just to
// serve those other maps.
export async function withKeyedStartLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  locks.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

export function createSitePreviewLifecycle(input: {
  allowOrigin: (url: string) => () => void;
}) {
  // Own start-lock map, keyed by the same previewKey() every other method
  // here already uses — the key format now has exactly one home instead of
  // main.ts keeping a second copy just to build the same string.
  const startLocks = new Map<string, Promise<void>>();
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
    // Matches siteRunner's own MAX_LOG_ENTRIES (500): slicing to one less
    // here leaves room for the synthetic "exited unexpectedly" entry this
    // appends next, so the exited record's log list still tops out at
    // exactly 500 entries instead of growing past the cap by one.
    const logs = active.handle.logs().slice(-EXITED_LOG_ENTRY_BUDGET);
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

    // Serializes concurrent start/stop attempts for the SAME workspace+site
    // so a queued stop still sees whatever the operation ahead of it just
    // did, instead of racing it.
    withStartLock<T>(
      workspaceId: string,
      siteRoot: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      return withKeyedStartLock(startLocks, previewKey(workspaceId, siteRoot), operation);
    },
  };
}

// The stopSitePreview IPC handler's own body: guard, abort any pending
// start for this exact site, then take the lock and recheck before
// actually stopping. Extracted so main.ts's own test can call this
// directly instead of only pinning the ORDER of the calls inside the
// handler's source text — main.ts cannot be imported under Vitest, so its
// own test only pins that the handler routes through this function at all.
//
// getActiveWorkspaceId is a thunk, not a snapshotted value: the active
// workspace can change while this request is queued behind another
// start/stop for the same site, so the recheck after the lock is obtained
// must read the CURRENT value, not the one captured before queueing.
export async function stopSitePreviewForRequest(input: {
  getActiveWorkspaceId: () => string | undefined;
  workspaceId: string;
  siteRoot: string;
  starts: ReturnType<typeof createSitePreviewStartRegistry>;
  previews: ReturnType<typeof createSitePreviewLifecycle>;
}): Promise<void> {
  assertActiveWorkspaceForSite(
    input.getActiveWorkspaceId(),
    input.workspaceId,
    "site preview stop request",
    "stop the preview again",
  );
  // Aborting the pending start BEFORE taking the lock matters: a start
  // still in flight when the lock is acquired would otherwise finish,
  // register itself as the running preview, and race the stop this
  // request is trying to perform.
  input.starts.abortForSite(input.workspaceId, input.siteRoot);
  await input.previews.withStartLock(input.workspaceId, input.siteRoot, async () => {
    assertActiveWorkspaceForSite(
      input.getActiveWorkspaceId(),
      input.workspaceId,
      "site preview stop request",
      "stop the preview again",
    );
    await input.previews.stop(input.workspaceId, input.siteRoot);
  });
}
