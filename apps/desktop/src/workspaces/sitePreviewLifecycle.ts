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
function assertActiveWorkspaceForSite(
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
export const START_CANCELLED_MESSAGE =
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
  // The window whose closing cancels this start, or null for a start the
  // surfaces holding it own.
  senderId: number | null;
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

type StartedPreview<T> = T & { url: string; exited: boolean };
export type HeldPreview<T> = StartedPreview<T> & { generation: number };
// The answer to a start another surface replaced with a newer one before it
// finished. The newer start's preview reaches every surface when it settles.
export type ReplacedStart = { replaced: true };

// One surface showing an app's preview, in the window it lives in.
type PreviewHolder = { senderId: number; isCurrent: () => boolean };

// The surfaces showing one app's preview: an app's tab and its pinned panel
// can show the same preview at once. Each start is a new generation; the
// surfaces that did not ask for it are told when it settles.
type PreviewHold<T> = {
  workspaceId: string;
  siteRoot: string;
  generation: number;
  mode: string;
  holders: Map<string, PreviewHolder>;
  // The holders this generation's start answers directly.
  answered: Set<string>;
  answer: Promise<HeldPreview<T> | ReplacedStart>;
  state: "starting" | "ready" | "failed";
  // A newer start replaced this one before it finished.
  replaced: boolean;
  // Stops this start once no surface holds it.
  cancel: AbortController;
};

// What a surface that did not ask for a new start is told: the preview it now
// shows, or null when none runs.
export type SitePreviewReplacement<T> = {
  workspaceId: string;
  siteRoot: string;
  holderId: string;
  generation: number;
  preview: HeldPreview<T> | null;
};

// One count for every lifecycle in the process, so a surface can compare the
// generations it sees even when its workspace is attached again.
let lastGeneration = 0;

export function createSitePreviewLifecycle<
  T extends { logs: SiteLogEntry[] } = { logs: SiteLogEntry[] },
>(input: {
  allowOrigin: (url: string) => () => void;
  // Tells one surface, in its window, that the app's preview was replaced.
  notifyReplaced?: (senderId: number, replacement: SitePreviewReplacement<T>) => void;
}) {
  const startLanes = new Map<string, Promise<void>>();
  // Each app's current hold, and the starts still preparing to take over
  // from it.
  const holds = new Map<string, PreviewHold<T>>();
  const preparing = new Map<string, Set<PreviewHold<T>>>();
  // The last preview each app's start produced, replaced or not, so a failed
  // restart can tell surfaces what still runs.
  const lastStarted = new Map<string, HeldPreview<T>>();
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
    if (pending.senderId !== null) {
      const senderStarts = pendingBySender.get(pending.senderId);
      senderStarts?.delete(pending);
      if (senderStarts?.size === 0) pendingBySender.delete(pending.senderId);
    }
    const siteStarts = pendingBySite.get(pending.siteKey);
    siteStarts?.delete(pending);
    if (siteStarts?.size === 0) pendingBySite.delete(pending.siteKey);
    pending.settle();
  };

  const beginPending = (
    senderId: number | null,
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
    if (senderId !== null) {
      const senderStarts = pendingBySender.get(senderId) ?? new Set<PendingStart>();
      senderStarts.add(pending);
      pendingBySender.set(senderId, senderStarts);
    }
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

  async function start(startInput: {
    senderId: number | null;
    workspaceId: string;
    siteRoot: string;
    isCurrent: () => boolean;
    // Gets the start's own lifetime check, which execution must use: for a
    // shared start, it holds while any surface holding the preview does.
    prepare: (isCurrent: () => boolean) => Promise<
      (signal: AbortSignal) => Promise<SitePreviewExecution<T>>
    >;
    // Stops the start when it aborts.
    cancelled?: AbortSignal;
    // Runs once preparation passed, before the start replaces anything.
    // Answering false stops the start.
    onPrepared?: () => boolean;
  }): Promise<StartedPreview<T>> {
    if (retired) throw new Error(START_CANCELLED_MESSAGE);
    const pending = beginPending(
      startInput.senderId,
      startInput.workspaceId,
      startInput.siteRoot,
    );
    const key = pending.siteKey;
    if (startInput.cancelled?.aborted) pending.controller.abort();
    startInput.cancelled?.addEventListener("abort", () => pending.controller.abort(), { once: true });
    const isCurrent = () =>
      !retired && !pending.controller.signal.aborted && startInput.isCurrent();
    const requireCurrent = (): void => {
      if (!isCurrent()) throw new Error(START_CANCELLED_MESSAGE);
    };

    try {
      requireCurrent();
      const execute = await startInput.prepare(isCurrent);
      requireCurrent();
      if (startInput.onPrepared && !startInput.onPrepared()) {
        throw new Error(START_CANCELLED_MESSAGE);
      }
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

  /**
   * Shows the app's preview in one more surface. A surface that asks for the
   * mode already running, or starting, shares it. A different mode, or a
   * restart the person asked for, starts the app's preview again. That start
   * takes over once it passes preparation: from then on every surface showing
   * the app follows it, and a start it replaced answers that it was replaced.
   * A start that fails preparation changes nothing for the other surfaces. A
   * start lasts as long as any surface holding it does, whichever window
   * asked first.
   */
  function acquire(acquireInput: {
    holderId: string;
    senderId: number;
    workspaceId: string;
    siteRoot: string;
    mode: string;
    restart: boolean;
    isCurrent: () => boolean;
    prepare: (isCurrent: () => boolean) => Promise<
      (signal: AbortSignal) => Promise<SitePreviewExecution<T>>
    >;
  }): Promise<HeldPreview<T> | ReplacedStart> {
    const key = previewKey(acquireInput.workspaceId, acquireInput.siteRoot);
    const holder: PreviewHolder = {
      senderId: acquireInput.senderId,
      isCurrent: acquireInput.isCurrent,
    };
    const current = holds.get(key);
    const running = activePreviews.get(key)?.state === "running";
    const joinable =
      [...(preparing.get(key) ?? [])].reverse().find((hold) => hold.mode === acquireInput.mode) ??
      (current?.mode === acquireInput.mode &&
      (current.state === "starting" ||
        (current.state === "ready" && !acquireInput.restart && running))
        ? current
        : undefined);
    if (joinable) {
      joinable.holders.set(acquireInput.holderId, holder);
      joinable.answered.add(acquireInput.holderId);
      return joinable.answer;
    }

    const generation = ++lastGeneration;
    const holders = new Map([[acquireInput.holderId, holder]]);
    const cancel = new AbortController();
    const started = start({
      senderId: null,
      workspaceId: acquireInput.workspaceId,
      siteRoot: acquireInput.siteRoot,
      isCurrent: () => [...holders.values()].some((each) => each.isCurrent()),
      cancelled: cancel.signal,
      prepare: acquireInput.prepare,
      onPrepared: () => takeOver(key, hold),
    });
    const hold: PreviewHold<T> = {
      workspaceId: acquireInput.workspaceId,
      siteRoot: acquireInput.siteRoot,
      generation,
      mode: acquireInput.mode,
      holders,
      answered: new Set([acquireInput.holderId]),
      cancel,
      answer: started.then(
        (preview): HeldPreview<T> | ReplacedStart => {
          const held = { ...preview, generation };
          lastStarted.set(key, held);
          return hold.replaced ? { replaced: true } : held;
        },
        (error: unknown): ReplacedStart => {
          if (hold.replaced) return { replaced: true };
          throw error;
        },
      ),
      state: "starting",
      replaced: false,
    };
    const waiting = preparing.get(key) ?? new Set<PreviewHold<T>>();
    waiting.add(hold);
    preparing.set(key, waiting);
    hold.answer.then(
      (answer) => {
        stopPreparing(key, hold);
        hold.state = "ready";
        if (!("replaced" in answer)) tellOthers(key, hold, answer);
      },
      () => {
        stopPreparing(key, hold);
        hold.state = "failed";
        // Tell the others what still runs: the start may have stopped the
        // old preview, or failed before it could.
        const running = activePreviews.get(key);
        const last = lastStarted.get(key);
        tellOthers(
          key,
          hold,
          running?.state === "running" && last?.url === running.handle.url ? last : null,
        );
      },
    );
    return hold.answer;
  }

  function stopPreparing(key: string, hold: PreviewHold<T>): void {
    const waiting = preparing.get(key);
    waiting?.delete(hold);
    if (waiting?.size === 0) preparing.delete(key);
  }

  /**
   * A start passed preparation and takes over the app's preview: the older
   * starts give way, and their surfaces follow it. Answers false when a newer
   * start already took over, so this one stops as replaced.
   */
  function takeOver(key: string, hold: PreviewHold<T>): boolean {
    stopPreparing(key, hold);
    const current = holds.get(key);
    if (current && current.generation > hold.generation) {
      hold.replaced = true;
      return false;
    }
    for (const older of [current, ...(preparing.get(key) ?? [])]) {
      if (!older || older.generation > hold.generation) continue;
      for (const [holderId, holder] of older.holders) {
        if (!hold.holders.has(holderId)) hold.holders.set(holderId, holder);
      }
      if (older.state === "starting") older.replaced = true;
      if (older !== current) stopPreparing(key, older);
    }
    holds.set(key, hold);
    return true;
  }

  // Tells the surfaces that did not ask for this generation what they show
  // now. A generation another start already replaced tells no one.
  function tellOthers(
    key: string,
    hold: PreviewHold<T>,
    preview: HeldPreview<T> | null,
  ): void {
    if (holds.get(key) !== hold || !input.notifyReplaced) return;
    for (const [holderId, holder] of hold.holders) {
      if (hold.answered.has(holderId)) continue;
      input.notifyReplaced(holder.senderId, {
        workspaceId: hold.workspaceId,
        siteRoot: hold.siteRoot,
        holderId,
        generation: hold.generation,
        preview,
      });
    }
  }

  // Takes one surface, or every surface of a window, out of an app's holds. A
  // start no surface holds any more stops; a preview no surface shows stops.
  // Starts that other surfaces hold go on.
  function letGo(key: string, matches: (holder: [string, PreviewHolder]) => boolean): boolean {
    for (const hold of [...(preparing.get(key) ?? [])]) {
      for (const entry of hold.holders) if (matches(entry)) hold.holders.delete(entry[0]);
      if (hold.holders.size > 0) continue;
      hold.cancel.abort();
      stopPreparing(key, hold);
    }
    const current = holds.get(key);
    if (!current) return false;
    let removed = false;
    for (const entry of current.holders) {
      if (!matches(entry)) continue;
      current.holders.delete(entry[0]);
      removed = true;
    }
    if (!removed || current.holders.size > 0) return false;
    current.cancel.abort();
    holds.delete(key);
    return true;
  }

  /**
   * One surface stops showing the app's preview. The preview stops when no
   * surface shows it any more.
   */
  async function release(releaseInput: {
    getActiveWorkspaceId: () => string | undefined;
    holderId: string;
    workspaceId: string;
    siteRoot: string;
  }): Promise<void> {
    const key = previewKey(releaseInput.workspaceId, releaseInput.siteRoot);
    const hadHold = holds.has(key);
    const emptied = letGo(key, ([holderId]) => holderId === releaseInput.holderId);
    // Another surface still shows it, or this surface already let go.
    if (hadHold && !emptied) return;
    // With no surface holding it, what runs is stopped: this also retries a
    // stop that failed. A start another surface is preparing goes on.
    assertActiveWorkspaceForSite(
      releaseInput.getActiveWorkspaceId(),
      releaseInput.workspaceId,
      "app preview stop request",
      "stop the preview again",
    );
    await runInKeyedLane(startLanes, key, async () => {
      assertActiveWorkspaceForSite(
        releaseInput.getActiveWorkspaceId(),
        releaseInput.workspaceId,
        "app preview stop request",
        "stop the preview again",
      );
      await stopCurrent(key);
    });
  }

  function dropHolds(workspaceId?: string): void {
    for (const map of [holds, preparing]) {
      for (const key of [...map.keys()]) {
        if (workspaceId === undefined || key.startsWith(previewKey(workspaceId, ""))) {
          map.delete(key);
        }
      }
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
      "app preview stop request",
      "stop the preview again",
    );
    const key = previewKey(stopInput.workspaceId, stopInput.siteRoot);
    abortPending(pendingBySite.get(key) ?? []);
    await runInKeyedLane(startLanes, key, async () => {
      assertActiveWorkspaceForSite(
        stopInput.getActiveWorkspaceId(),
        stopInput.workspaceId,
        "app preview stop request",
        "stop the preview again",
      );
      await stopCurrent(key);
    });
  }

  // A window that went away shows nothing any more: its surfaces let go, and
  // a preview, or a start, only it showed stops.
  function cancelSender(senderId: number): void {
    abortPending(pendingBySender.get(senderId) ?? []);
    for (const key of new Set([...holds.keys(), ...preparing.keys()])) {
      if (!letGo(key, ([, holder]) => holder.senderId === senderId)) continue;
      void runInKeyedLane(startLanes, key, () => stopCurrent(key)).catch((error) => {
        console.warn("[desktop] failed to stop an app preview no window shows", error);
      });
    }
  }

  async function stopWorkspace(workspaceId: string): Promise<void> {
    dropHolds(workspaceId);
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
    dropHolds();
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
    acquire,
    release,
    status,
    stop,
    cancelSender,
    stopWorkspace,
    stopAll,
  };
}
