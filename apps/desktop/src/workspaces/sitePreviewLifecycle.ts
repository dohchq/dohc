import {
  MAX_LOG_ENTRIES,
  type SiteLogEntry,
  type SiteProcessHandle,
  type StaticSitePreview,
} from "./siteRunner";
import { runInKeyedLane } from "../keyedLane";

type SitePreviewHandle = StaticSitePreview | SiteProcessHandle;

// requireWorkspace alone only proves a workspaceId is registered somewhere
// in this app instance. Site IPC also needs to prove that the sender still
// shows that workspace.
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

const EXITED_LOG_ENTRY_BUDGET = MAX_LOG_ENTRIES - 1;
const START_CANCELLED_MESSAGE =
  "App preview start was cancelled because the renderer restarted.";

type RunningPreview = {
  state: "running";
  workspaceId: string;
  siteRoot: string;
  handle: SitePreviewHandle;
  releaseOrigin: (() => void) | null;
};

type ExitedPreview = {
  state: "exited";
  workspaceId: string;
  siteRoot: string;
  handle: SiteProcessHandle;
  releaseOrigin: null;
  logs: SiteLogEntry[];
};

type StoppingPreview = {
  // A rejected stop is not proof that the process or server died. Keep the
  // exact handle here so replacements cannot start over it. Concurrent calls
  // share stopAttempt; a later call retries after a rejected attempt.
  state: "stopping";
  lastKnownState: "running" | "exited";
  workspaceId: string;
  siteRoot: string;
  handle: SitePreviewHandle;
  releaseOrigin: null;
  logs: SiteLogEntry[];
  stopAttempt: Promise<void> | null;
};

type PreviewRecord = RunningPreview | ExitedPreview | StoppingPreview;

type PendingStart = {
  sequence: number;
  senderId: number;
  workspaceId: string;
  siteKey: string;
  phase: "preparing" | "queued" | "executing";
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
};

export type SitePreviewStatus = {
  logs: SiteLogEntry[];
  running: boolean;
  exited: boolean;
};

export type SitePreviewExecution<T extends { logs: SiteLogEntry[] }> = {
  handle: SitePreviewHandle;
  result: T;
};

export function createSitePreviewLifecycle(input: {
  allowOrigin: (url: string) => () => void;
}) {
  const startLanes = new Map<string, Promise<void>>();
  const activePreviews = new Map<string, PreviewRecord>();
  const pendingStarts = new Set<PendingStart>();
  const pendingBySender = new Map<number, Set<PendingStart>>();
  const pendingBySite = new Map<string, Set<PendingStart>>();
  let nextStartSequence = 0;
  let retired = false;

  const releaseOrigin = (record: PreviewRecord): void => {
    const release = record.releaseOrigin;
    if (!release) return;
    record.releaseOrigin = null;
    release();
  };

  const logsFor = (record: PreviewRecord): SiteLogEntry[] => {
    if (record.state === "exited" || record.state === "stopping") {
      return [...record.logs];
    }
    return "logs" in record.handle ? record.handle.logs() : [];
  };

  const removePending = (pending: PendingStart): void => {
    pendingStarts.delete(pending);
    const senderStarts = pendingBySender.get(pending.senderId);
    senderStarts?.delete(pending);
    if (senderStarts?.size === 0) pendingBySender.delete(pending.senderId);
    const siteStarts = pendingBySite.get(pending.siteKey);
    siteStarts?.delete(pending);
    if (siteStarts?.size === 0) pendingBySite.delete(pending.siteKey);
    pending.settle();
  };

  const beginPending = (
    senderId: number,
    workspaceId: string,
    siteRoot: string,
  ): PendingStart => {
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const pending: PendingStart = {
      sequence: nextStartSequence,
      senderId,
      workspaceId,
      siteKey: previewKey(workspaceId, siteRoot),
      phase: "preparing",
      controller: new AbortController(),
      settled,
      settle,
    };
    nextStartSequence += 1;
    pendingStarts.add(pending);
    const senderStarts = pendingBySender.get(senderId) ?? new Set<PendingStart>();
    senderStarts.add(pending);
    pendingBySender.set(senderId, senderStarts);
    const siteStarts = pendingBySite.get(pending.siteKey) ?? new Set<PendingStart>();
    siteStarts.add(pending);
    pendingBySite.set(pending.siteKey, siteStarts);
    return pending;
  };

  const supersedeOlderStarts = (pending: PendingStart): void => {
    for (const older of pendingBySite.get(pending.siteKey) ?? []) {
      if (
        older.sequence < pending.sequence &&
        older.phase !== "executing"
      ) {
        older.controller.abort();
      }
    }
  };

  const abortPending = (starts: Iterable<PendingStart>): PendingStart[] => {
    const pending = [...starts];
    for (const start of pending) start.controller.abort();
    return pending;
  };

  const markExitedIfCurrent = (
    workspaceId: string,
    siteRoot: string,
    expected: SiteProcessHandle,
  ): void => {
    const key = previewKey(workspaceId, siteRoot);
    const active = activePreviews.get(key);
    if (active?.state !== "running" || active.handle !== expected) return;
    const logs = active.handle.logs().slice(-EXITED_LOG_ENTRY_BUDGET);
    logs.push({
      stream: "system",
      text: "Dev server exited unexpectedly.",
      at: Date.now(),
    });
    releaseOrigin(active);
    activePreviews.set(key, {
      state: "exited",
      workspaceId,
      siteRoot,
      handle: active.handle,
      releaseOrigin: null,
      logs,
    });
  };

  const stopRetained = (
    key: string,
    record: StoppingPreview,
  ): Promise<void> => {
    if (record.stopAttempt) return record.stopAttempt;
    const attempt = Promise.resolve()
      .then(() => record.handle.stop())
      .then(() => {
        if (activePreviews.get(key) === record) activePreviews.delete(key);
      })
      .finally(() => {
        if (
          activePreviews.get(key) === record &&
          record.stopAttempt === attempt
        ) {
          record.stopAttempt = null;
        }
      });
    record.stopAttempt = attempt;
    return attempt;
  };

  const stopCurrent = async (
    key: string,
    expected?: SitePreviewHandle,
  ): Promise<void> => {
    const active = activePreviews.get(key);
    if (expected && active?.handle !== expected) return;
    if (!active) return;
    if (active.state === "stopping") {
      await stopRetained(key, active);
      return;
    }
    const release = active.releaseOrigin;
    active.releaseOrigin = null;
    const stopping: StoppingPreview = {
      state: "stopping",
      lastKnownState: active.state,
      workspaceId: active.workspaceId,
      siteRoot: active.siteRoot,
      handle: active.handle,
      releaseOrigin: null,
      logs: logsFor(active),
      stopAttempt: null,
    };
    activePreviews.set(key, stopping);
    try {
      release?.();
    } finally {
      await stopRetained(key, stopping);
    }
  };

  const retainAndStop = async (
    workspaceId: string,
    siteRoot: string,
    handle: SitePreviewHandle,
  ): Promise<void> => {
    const key = previewKey(workspaceId, siteRoot);
    const active = activePreviews.get(key);
    if (active) {
      if (active.handle !== handle) {
        throw new Error(
          "A different app preview already owns this workspace and app.",
        );
      }
      await stopCurrent(key, handle);
      return;
    }
    const stopping: StoppingPreview = {
      state: "stopping",
      lastKnownState: "running",
      workspaceId,
      siteRoot,
      handle,
      releaseOrigin: null,
      logs: "logs" in handle ? handle.logs() : [],
      stopAttempt: null,
    };
    activePreviews.set(key, stopping);
    await stopRetained(key, stopping);
  };

  const failAfterCleanup = async (
    error: unknown,
    cleanup: () => Promise<void>,
  ): Promise<never> => {
    try {
      await cleanup();
    } catch (cleanupError) {
      const message =
        error instanceof Error ? error.message : "App preview start failed.";
      throw new AggregateError([error, cleanupError], message);
    }
    throw error;
  };

  const install = async (
    workspaceId: string,
    siteRoot: string,
    handle: SitePreviewHandle,
  ): Promise<void> => {
    const key = previewKey(workspaceId, siteRoot);
    try {
      const releaseAllowedOrigin = input.allowOrigin(handle.url);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseAllowedOrigin();
      };
      const record: RunningPreview = {
        state: "running",
        workspaceId,
        siteRoot,
        handle,
        releaseOrigin: release,
      };
      activePreviews.set(key, record);
      if ("onExit" in handle) {
        handle.onExit(() => markExitedIfCurrent(workspaceId, siteRoot, handle));
      }
    } catch (error) {
      const current = activePreviews.get(key);
      await failAfterCleanup(error, () =>
        current?.handle === handle
          ? stopCurrent(key, handle)
          : retainAndStop(workspaceId, siteRoot, handle),
      );
    }
  };

  async function start<T extends { logs: SiteLogEntry[] }>(startInput: {
    senderId: number;
    workspaceId: string;
    siteRoot: string;
    isCurrent: () => boolean;
    prepare: () => Promise<
      (signal: AbortSignal) => Promise<SitePreviewExecution<T>>
    >;
  }): Promise<T & { url: string; exited: boolean }> {
    if (retired) throw new Error(START_CANCELLED_MESSAGE);
    const pending = beginPending(
      startInput.senderId,
      startInput.workspaceId,
      startInput.siteRoot,
    );
    const key = pending.siteKey;
    const isCurrent = () =>
      !retired && !pending.controller.signal.aborted && startInput.isCurrent();
    const requireCurrent = (): void => {
      if (!isCurrent()) throw new Error(START_CANCELLED_MESSAGE);
    };

    try {
      requireCurrent();
      const execute = await startInput.prepare();
      requireCurrent();
      supersedeOlderStarts(pending);
      pending.phase = "queued";
      return await runInKeyedLane(startLanes, key, async () => {
        requireCurrent();
        pending.phase = "executing";
        await stopCurrent(key);
        requireCurrent();

        const execution = await execute(pending.controller.signal);
        if (!isCurrent()) {
          await failAfterCleanup(new Error(START_CANCELLED_MESSAGE), () =>
            retainAndStop(
              startInput.workspaceId,
              startInput.siteRoot,
              execution.handle,
            ),
          );
        }

        await install(startInput.workspaceId, startInput.siteRoot, execution.handle);

        // onExit queues its callback when the process exited just before the
        // listener attached. This turn also lets sender teardown cancel the
        // request before its result escapes the owner.
        await Promise.resolve();
        if (!isCurrent()) {
          await failAfterCleanup(new Error(START_CANCELLED_MESSAGE), () =>
            stopCurrent(key, execution.handle),
          );
        }

        const active = activePreviews.get(key);
        if (active?.handle === execution.handle && active.state === "running") {
          return {
            ...execution.result,
            url: execution.handle.url,
            exited: false,
          };
        }
        if (active?.handle === execution.handle && active.state === "exited") {
          return {
            ...execution.result,
            url: execution.handle.url,
            logs: [...active.logs],
            exited: true,
          };
        }
        throw new Error(
          "The app preview stopped before it opened. Start the preview again.",
        );
      });
    } finally {
      removePending(pending);
    }
  }

  function status(workspaceId: string, siteRoot: string): SitePreviewStatus {
    const active = activePreviews.get(previewKey(workspaceId, siteRoot));
    if (!active) return { logs: [], running: false, exited: false };
    if (active.state === "exited") {
      return { logs: [...active.logs], running: false, exited: true };
    }
    if (active.state === "stopping") {
      return {
        logs: [...active.logs],
        running: active.lastKnownState === "running",
        exited: active.lastKnownState === "exited",
      };
    }
    return {
      logs: "logs" in active.handle ? active.handle.logs() : [],
      running: true,
      exited: false,
    };
  }

  async function stop(stopInput: {
    getActiveWorkspaceId: () => string | undefined;
    workspaceId: string;
    siteRoot: string;
  }): Promise<void> {
    assertActiveWorkspaceForSite(
      stopInput.getActiveWorkspaceId(),
      stopInput.workspaceId,
      "site preview stop request",
      "stop the preview again",
    );
    const key = previewKey(stopInput.workspaceId, stopInput.siteRoot);
    abortPending(pendingBySite.get(key) ?? []);
    await runInKeyedLane(startLanes, key, async () => {
      assertActiveWorkspaceForSite(
        stopInput.getActiveWorkspaceId(),
        stopInput.workspaceId,
        "site preview stop request",
        "stop the preview again",
      );
      await stopCurrent(key);
    });
  }

  function cancelSender(senderId: number): void {
    abortPending(pendingBySender.get(senderId) ?? []);
  }

  async function stopWorkspace(workspaceId: string): Promise<void> {
    const pending = abortPending(
      [...pendingStarts].filter((start) => start.workspaceId === workspaceId),
    );
    const draining = pending.filter((start) => start.phase !== "preparing");
    const snapshots = [...activePreviews.entries()]
      .filter(([, active]) => active.workspaceId === workspaceId)
      .map(([key, active]) => ({ key, handle: active.handle }));
    await Promise.all([
      ...snapshots.map(({ key, handle }) =>
        runInKeyedLane(startLanes, key, () => stopCurrent(key, handle)).catch(
          (error) => {
            console.warn(
              "[desktop] failed to stop site preview during workspace switch",
              error,
            );
          },
        ),
      ),
      ...draining.map((start) => start.settled),
    ]);
  }

  let stopAllPromise: Promise<void> | null = null;

  function stopAll(): Promise<void> {
    if (stopAllPromise) return stopAllPromise;
    retired = true;
    const pending = abortPending(pendingStarts);
    const draining = pending.filter((start) => start.phase !== "preparing");
    const keys = new Set([
      ...startLanes.keys(),
      ...activePreviews.keys(),
      ...pending.map((start) => start.siteKey),
    ]);
    const drains = [...keys].map((key) =>
      runInKeyedLane(startLanes, key, () => stopCurrent(key)),
    );
    const attempt = Promise.allSettled([
      ...drains,
      ...draining.map((start) => start.settled),
    ]).then((results) => {
      const errors = results
        .filter((result): result is PromiseRejectedResult =>
          result.status === "rejected",
        )
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Some app previews did not stop.");
      }
    });
    stopAllPromise = attempt;
    void attempt.catch(() => {
      // Successful retirement stays memoized. A failed attempt leaves exact
      // stopping records behind, so the next call must get a fresh retry.
      if (stopAllPromise === attempt) stopAllPromise = null;
    });
    return attempt;
  }

  return {
    start,
    status,
    stop,
    cancelSender,
    stopWorkspace,
    stopAll,
  };
}
