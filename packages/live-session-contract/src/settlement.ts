export const SETTLEMENT_QUIET_MS = 800;
export const SETTLEMENT_END_TO_END_MAX_MS = 5_000;

export type SettlementReason =
  | "quiet"
  | "hard-limit"
  | "last-editor-disconnect"
  | "orderly-shutdown"
  | "maintenance-drain";

type TimerSettlementReason = Extract<
  SettlementReason,
  "quiet" | "hard-limit"
>;
type ExplicitSettlementReason = Exclude<
  SettlementReason,
  TimerSettlementReason
>;

interface SettlementSchedulerEventBase {
  eventTimeMs: number;
  firstDirtyHostTimeMs: number;
  windowId: number;
}

export type SettlementSchedulerEvent =
  | (SettlementSchedulerEventBase & {
      type: "window-open";
    })
  | (SettlementSchedulerEventBase & {
      reason: SettlementReason;
      type:
        | "trigger"
        | "settlement-start"
        | "settlement-success"
        | "settlement-failure";
    });

export interface SettlementSchedulerOptions {
  clearTimer?: (timer: unknown) => void;
  hardTriggerMs: number;
  now?: () => number;
  onEvent: (event: SettlementSchedulerEvent) => void;
  settle: (reason: SettlementReason) => Promise<void> | void;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
}

export interface SettlementSchedulerHandle {
  flush(reason: ExplicitSettlementReason): Promise<void>;
  markDirty(hostReceivedAtMs: number): void;
}

interface TimerRegistration {
  handle: unknown;
}

type WindowStatus = "open" | "due" | "settling" | "failed";

interface DirtyWindow {
  firstDirtyHostTimeMs: number;
  hardTimer: TimerRegistration | null;
  id: number;
  latestDirtyHostTimeMs: number;
  quietTimer: TimerRegistration | null;
  reason: SettlementReason | null;
  status: WindowStatus;
}

interface FlushWaiter {
  reject: (error: unknown) => void;
  resolve: () => void;
  targetWindowId: number;
}

const MAX_RETAINED_WINDOWS = 2;

export function createSettlementScheduler(
  options: SettlementSchedulerOptions,
): SettlementSchedulerHandle {
  if (
    !Number.isFinite(options.hardTriggerMs) ||
    !Number.isInteger(options.hardTriggerMs) ||
    options.hardTriggerMs <= 0 ||
    options.hardTriggerMs >= SETTLEMENT_END_TO_END_MAX_MS
  ) {
    throw new RangeError(
      `hardTriggerMs must be a positive integer below ${SETTLEMENT_END_TO_END_MAX_MS}`,
    );
  }

  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number): unknown =>
      setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown): void =>
      clearTimeout(timer as ReturnType<typeof setTimeout>));

  const windows: DirtyWindow[] = [];
  const flushWaiters: FlushWaiter[] = [];
  let draining = false;
  let nextWindowId = 1;
  let openWindow: DirtyWindow | null = null;

  function emit(
    window: DirtyWindow,
    event:
      | { type: "window-open" }
      | {
          reason: SettlementReason;
          type:
            | "trigger"
            | "settlement-start"
            | "settlement-success"
            | "settlement-failure";
        },
  ): void {
    const record = {
      eventTimeMs: now(),
      firstDirtyHostTimeMs: window.firstDirtyHostTimeMs,
      windowId: window.id,
      ...event,
    } satisfies SettlementSchedulerEvent;
    try {
      options.onEvent(record);
    } catch {
      // Instrumentation cannot change settlement state.
    }
  }

  function cancelTimer(registration: TimerRegistration | null): void {
    if (registration !== null) clearTimer(registration.handle);
  }

  function cancelWindowTimers(window: DirtyWindow): void {
    cancelTimer(window.quietTimer);
    cancelTimer(window.hardTimer);
    window.quietTimer = null;
    window.hardTimer = null;
  }

  function nextTimerDeadline(window: DirtyWindow): {
    dueAtMs: number;
    reason: TimerSettlementReason;
  } {
    const quietDueAtMs =
      window.latestDirtyHostTimeMs + SETTLEMENT_QUIET_MS;
    const hardDueAtMs =
      window.firstDirtyHostTimeMs + options.hardTriggerMs;
    return quietDueAtMs <= hardDueAtMs
      ? { dueAtMs: quietDueAtMs, reason: "quiet" }
      : { dueAtMs: hardDueAtMs, reason: "hard-limit" };
  }

  function triggerElapsedWindow(window: DirtyWindow): void {
    if (window.status !== "open") return;
    const deadline = nextTimerDeadline(window);
    if (deadline.dueAtMs > now()) return;
    triggerWindow(window, deadline.reason);
  }

  function armQuietTimer(window: DirtyWindow): void {
    const dueAtMs = window.latestDirtyHostTimeMs + SETTLEMENT_QUIET_MS;
    const registration: TimerRegistration = { handle: undefined };
    window.quietTimer = registration;
    registration.handle = setTimer(() => {
      if (window.quietTimer !== registration) return;
      window.quietTimer = null;
      triggerElapsedWindow(window);
    }, Math.max(0, dueAtMs - now()));
  }

  function armHardTimer(window: DirtyWindow): void {
    const dueAtMs = window.firstDirtyHostTimeMs + options.hardTriggerMs;
    const registration: TimerRegistration = { handle: undefined };
    window.hardTimer = registration;
    registration.handle = setTimer(() => {
      if (window.hardTimer !== registration) return;
      window.hardTimer = null;
      triggerElapsedWindow(window);
    }, Math.max(0, dueAtMs - now()));
  }

  function armNewWindow(window: DirtyWindow): void {
    const deadline = nextTimerDeadline(window);
    if (deadline.dueAtMs <= now()) {
      triggerWindow(window, deadline.reason);
      return;
    }
    armQuietTimer(window);
    armHardTimer(window);
  }

  function mergeIntoOpenWindow(
    window: DirtyWindow,
    hostReceivedAtMs: number,
  ): void {
    const previousDeadline = nextTimerDeadline(window);
    if (hostReceivedAtMs >= previousDeadline.dueAtMs) {
      triggerWindow(window, previousDeadline.reason);
      openDirtyWindow(hostReceivedAtMs);
      return;
    }

    cancelTimer(window.quietTimer);
    window.quietTimer = null;
    const firstDirtyChanged =
      hostReceivedAtMs < window.firstDirtyHostTimeMs;
    if (firstDirtyChanged) {
      cancelTimer(window.hardTimer);
      window.hardTimer = null;
      window.firstDirtyHostTimeMs = hostReceivedAtMs;
    }
    window.latestDirtyHostTimeMs = Math.max(
      window.latestDirtyHostTimeMs,
      hostReceivedAtMs,
    );

    const deadline = nextTimerDeadline(window);
    if (deadline.dueAtMs <= now()) {
      triggerWindow(window, deadline.reason);
      return;
    }
    armQuietTimer(window);
    if (window.hardTimer === null) armHardTimer(window);
  }

  function openDirtyWindow(hostReceivedAtMs: number): void {
    if (windows.length >= MAX_RETAINED_WINDOWS) {
      const tail = windows.at(-1)!;
      tail.latestDirtyHostTimeMs = Math.max(
        tail.latestDirtyHostTimeMs,
        hostReceivedAtMs,
      );
      return;
    }

    const window: DirtyWindow = {
      firstDirtyHostTimeMs: hostReceivedAtMs,
      hardTimer: null,
      id: nextWindowId,
      latestDirtyHostTimeMs: hostReceivedAtMs,
      quietTimer: null,
      reason: null,
      status: "open",
    };
    nextWindowId += 1;
    windows.push(window);
    openWindow = window;
    emit(window, { type: "window-open" });
    armNewWindow(window);
  }

  function resolveFlushWaiters(windowId: number): void {
    for (let index = flushWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = flushWaiters[index]!;
      if (waiter.targetWindowId !== windowId) continue;
      flushWaiters.splice(index, 1);
      waiter.resolve();
    }
  }

  function rejectFlushWaiters(error: unknown): void {
    const rejected = flushWaiters.splice(0);
    for (const waiter of rejected) waiter.reject(error);
  }

  async function settleWindow(window: DirtyWindow): Promise<boolean> {
    const reason = window.reason;
    if (reason === null) return false;

    window.status = "settling";
    emit(window, { reason, type: "settlement-start" });

    try {
      await options.settle(reason);
    } catch (error) {
      window.status = "failed";
      emit(window, { reason, type: "settlement-failure" });
      rejectFlushWaiters(error);
      return false;
    }

    emit(window, { reason, type: "settlement-success" });
    const index = windows.indexOf(window);
    if (index >= 0) windows.splice(index, 1);
    resolveFlushWaiters(window.id);
    return true;
  }

  async function drainQueue(): Promise<void> {
    if (draining) return;
    draining = true;

    try {
      while (windows[0]?.status === "due") {
        const settled = await settleWindow(windows[0]);
        if (!settled) return;
      }
    } finally {
      draining = false;
      if (windows[0]?.status === "due") void drainQueue();
    }
  }

  function triggerWindow(
    window: DirtyWindow,
    reason: SettlementReason,
  ): void {
    if (window.status !== "open" && window.status !== "failed") return;

    if (openWindow === window) openWindow = null;
    cancelWindowTimers(window);
    window.reason = reason;
    window.status = "due";
    emit(window, { reason, type: "trigger" });
    void drainQueue();
  }

  function markDirty(hostReceivedAtMs: number): void {
    if (!Number.isFinite(hostReceivedAtMs)) {
      throw new RangeError("hostReceivedAtMs must be finite");
    }

    if (openWindow !== null) {
      mergeIntoOpenWindow(openWindow, hostReceivedAtMs);
      return;
    }

    openDirtyWindow(hostReceivedAtMs);
  }

  function flush(reason: ExplicitSettlementReason): Promise<void> {
    const target = windows.at(-1);
    if (target === undefined) return Promise.resolve();

    const completion = new Promise<void>((resolve, reject) => {
      flushWaiters.push({ reject, resolve, targetWindowId: target.id });
    });

    for (const window of windows) {
      if (window.status === "open" || window.status === "failed") {
        triggerWindow(window, reason);
      }
    }
    void drainQueue();
    return completion;
  }

  return { flush, markDirty };
}
