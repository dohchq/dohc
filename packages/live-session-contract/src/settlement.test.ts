import { expect, it, vi } from "vitest";

import {
  SETTLEMENT_END_TO_END_MAX_MS,
  createSettlementScheduler,
  type SettlementReason,
  type SettlementSchedulerEvent,
  type SettlementSchedulerHandle,
  type SettlementSchedulerOptions,
} from "./settlement.js";

interface DeferredSettlement {
  promise: Promise<void>;
  reason: SettlementReason;
  reject: (error: Error) => void;
  resolve: () => void;
}

interface ManualClock {
  clearTimer: (timer: unknown) => void;
  now: () => number;
  runDueTimers: () => void;
  set: (timeMs: number) => void;
  setTimer: (callback: () => void, delayMs: number) => unknown;
}

function createDeferredSettlement(
  reason: SettlementReason,
): DeferredSettlement {
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reason, reject, resolve };
}

function createManualClock(initialTimeMs = 0): ManualClock {
  let currentTimeMs = initialTimeMs;
  let nextTimerId = 1;
  const timers = new Map<
    number,
    { callback: () => void; dueAtMs: number }
  >();

  return {
    clearTimer: (timer) => timers.delete(timer as number),
    now: () => currentTimeMs,
    runDueTimers: () => {
      for (;;) {
        const dueTimer = [...timers]
          .filter(([, timer]) => timer.dueAtMs <= currentTimeMs)
          .sort(
            ([leftId, left], [rightId, right]) =>
              left.dueAtMs - right.dueAtMs || leftId - rightId,
          )[0];
        if (dueTimer === undefined) return;
        timers.delete(dueTimer[0]);
        dueTimer[1].callback();
      }
    },
    set: (timeMs) => {
      currentTimeMs = timeMs;
    },
    setTimer: (callback, delayMs) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, {
        callback,
        dueAtMs: currentTimeMs + delayMs,
      });
      return timerId;
    },
  };
}

function proveExplicitFlushReasons(
  scheduler: SettlementSchedulerHandle,
): void {
  void scheduler.flush("last-editor-disconnect");
  void scheduler.flush("orderly-shutdown");
  void scheduler.flush("maintenance-drain");
  // @ts-expect-error Quiet is reserved for timer triggers.
  void scheduler.flush("quiet");
  // @ts-expect-error Hard limit is reserved for timer triggers.
  void scheduler.flush("hard-limit");
}

void proveExplicitFlushReasons;

it.each([
  [4_999, 800, "quiet"],
  [400, 400, "hard-limit"],
] as const)("settles after a backward clock jump with hard trigger %i", async (hardTriggerMs, dueAtMs, reason) => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const settle = vi.fn();
    const scheduler = createSettlementScheduler({
      hardTriggerMs,
      onEvent: () => undefined,
      settle,
    });
    scheduler.markDirty(0);
    vi.setSystemTime(-10_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000 + dueAtMs - 1);
    expect(settle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settle).toHaveBeenCalledExactlyOnceWith(reason);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("resets only quiet time and serializes every dirty window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);

  try {
    const inertOptions = {
      onEvent: () => undefined,
      settle: () => undefined,
    } satisfies Omit<SettlementSchedulerOptions, "hardTriggerMs">;

    for (const hardTriggerMs of [0, -1, 1.5, 5_000]) {
      expect(() =>
        createSettlementScheduler({ ...inertOptions, hardTriggerMs }),
      ).toThrow();
    }

    const events: SettlementSchedulerEvent[] = [];
    const settlements: DeferredSettlement[] = [];
    let activeSettlements = 0;
    let maximumActiveSettlements = 0;

    const scheduler = createSettlementScheduler({
      hardTriggerMs: SETTLEMENT_END_TO_END_MAX_MS - 1,
      onEvent: (event) => events.push(event),
      settle: (reason) => {
        activeSettlements += 1;
        maximumActiveSettlements = Math.max(
          maximumActiveSettlements,
          activeSettlements,
        );

        let reject!: (error: Error) => void;
        let resolve!: () => void;
        const deferred = new Promise<void>((resolvePromise, rejectPromise) => {
          reject = rejectPromise;
          resolve = resolvePromise;
        });
        const promise = deferred.finally(() => {
          activeSettlements -= 1;
        });
        settlements.push({ promise, reason, reject, resolve });
        return promise;
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    scheduler.markDirty(0);
    await vi.advanceTimersByTimeAsync(699);
    expect(settlements).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(settlements.map(({ reason }) => reason)).toEqual(["quiet"]);

    settlements[0]!.resolve();
    await settlements[0]!.promise;
    await Promise.resolve();

    scheduler.markDirty(800);
    for (const hostReceivedAtMs of [1_599, 2_398, 3_197, 3_996, 4_795, 5_594]) {
      await vi.advanceTimersByTimeAsync(799);
      expect(settlements).toHaveLength(1);
      scheduler.markDirty(hostReceivedAtMs);
    }
    await vi.advanceTimersByTimeAsync(204);
    expect(settlements).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(settlements.map(({ reason }) => reason)).toEqual([
      "quiet",
      "hard-limit",
    ]);

    scheduler.markDirty(5_799);
    await vi.advanceTimersByTimeAsync(800);
    expect(activeSettlements).toBe(1);
    expect(maximumActiveSettlements).toBe(1);
    expect(settlements).toHaveLength(2);

    settlements[1]!.resolve();
    await settlements[1]!.promise;
    await Promise.resolve();
    expect(settlements).toHaveLength(3);
    expect(settlements[2]!.reason).toBe("quiet");
    expect(activeSettlements).toBe(1);
    expect(maximumActiveSettlements).toBe(1);

    settlements[2]!.resolve();
    await settlements[2]!.promise;
    await Promise.resolve();

    scheduler.markDirty(6_599);
    let orderlyFlushResolved = false;
    const orderlyFlush = scheduler.flush("orderly-shutdown").then(() => {
      orderlyFlushResolved = true;
    });
    await Promise.resolve();
    expect(orderlyFlushResolved).toBe(false);
    expect(settlements[3]!.reason).toBe("orderly-shutdown");
    settlements[3]!.resolve();
    await orderlyFlush;
    expect(orderlyFlushResolved).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    scheduler.markDirty(6_600);
    await vi.advanceTimersByTimeAsync(800);
    const settlementFailure = new Error("timer settlement failed");
    settlements[4]!.reject(settlementFailure);
    await expect(settlements[4]!.promise).rejects.toBe(settlementFailure);
    await Promise.resolve();

    const failedWindow = [...events].reverse().find(
      (event) => event.type === "settlement-failure",
    );
    expect(failedWindow).toMatchObject({
      firstDirtyHostTimeMs: 6_600,
      reason: "quiet",
      windowId: 5,
    });

    const retryFlush = scheduler.flush("maintenance-drain");
    await Promise.resolve();
    expect(settlements).toHaveLength(6);
    expect(settlements[5]!.reason).toBe("maintenance-drain");
    settlements[5]!.resolve();
    await retryFlush;

    expect(maximumActiveSettlements).toBe(1);
    expect(events).toEqual([
      {
        eventTimeMs: 100,
        firstDirtyHostTimeMs: 0,
        type: "window-open",
        windowId: 1,
      },
      {
        eventTimeMs: 800,
        firstDirtyHostTimeMs: 0,
        reason: "quiet",
        type: "trigger",
        windowId: 1,
      },
      {
        eventTimeMs: 800,
        firstDirtyHostTimeMs: 0,
        reason: "quiet",
        type: "settlement-start",
        windowId: 1,
      },
      {
        eventTimeMs: 800,
        firstDirtyHostTimeMs: 0,
        reason: "quiet",
        type: "settlement-success",
        windowId: 1,
      },
      {
        eventTimeMs: 800,
        firstDirtyHostTimeMs: 800,
        type: "window-open",
        windowId: 2,
      },
      {
        eventTimeMs: 5_799,
        firstDirtyHostTimeMs: 800,
        reason: "hard-limit",
        type: "trigger",
        windowId: 2,
      },
      {
        eventTimeMs: 5_799,
        firstDirtyHostTimeMs: 800,
        reason: "hard-limit",
        type: "settlement-start",
        windowId: 2,
      },
      {
        eventTimeMs: 5_799,
        firstDirtyHostTimeMs: 5_799,
        type: "window-open",
        windowId: 3,
      },
      {
        eventTimeMs: 6_599,
        firstDirtyHostTimeMs: 5_799,
        reason: "quiet",
        type: "trigger",
        windowId: 3,
      },
      {
        eventTimeMs: 6_599,
        firstDirtyHostTimeMs: 800,
        reason: "hard-limit",
        type: "settlement-success",
        windowId: 2,
      },
      {
        eventTimeMs: 6_599,
        firstDirtyHostTimeMs: 5_799,
        reason: "quiet",
        type: "settlement-start",
        windowId: 3,
      },
      {
        eventTimeMs: 6_599,
        firstDirtyHostTimeMs: 5_799,
        reason: "quiet",
        type: "settlement-success",
        windowId: 3,
      },
      {
        eventTimeMs: 6_599,
        firstDirtyHostTimeMs: 6_599,
        type: "window-open",
        windowId: 4,
      },
      {
        eventTimeMs: 6_599,
        firstDirtyHostTimeMs: 6_599,
        reason: "orderly-shutdown",
        type: "trigger",
        windowId: 4,
      },
      {
        eventTimeMs: 6_599,
        firstDirtyHostTimeMs: 6_599,
        reason: "orderly-shutdown",
        type: "settlement-start",
        windowId: 4,
      },
      {
        eventTimeMs: 6_599,
        firstDirtyHostTimeMs: 6_599,
        reason: "orderly-shutdown",
        type: "settlement-success",
        windowId: 4,
      },
      {
        eventTimeMs: 6_600,
        firstDirtyHostTimeMs: 6_600,
        type: "window-open",
        windowId: 5,
      },
      {
        eventTimeMs: 7_400,
        firstDirtyHostTimeMs: 6_600,
        reason: "quiet",
        type: "trigger",
        windowId: 5,
      },
      {
        eventTimeMs: 7_400,
        firstDirtyHostTimeMs: 6_600,
        reason: "quiet",
        type: "settlement-start",
        windowId: 5,
      },
      {
        eventTimeMs: 7_400,
        firstDirtyHostTimeMs: 6_600,
        reason: "quiet",
        type: "settlement-failure",
        windowId: 5,
      },
      {
        eventTimeMs: 7_400,
        firstDirtyHostTimeMs: 6_600,
        reason: "maintenance-drain",
        type: "trigger",
        windowId: 5,
      },
      {
        eventTimeMs: 7_400,
        firstDirtyHostTimeMs: 6_600,
        reason: "maintenance-drain",
        type: "settlement-start",
        windowId: 5,
      },
      {
        eventTimeMs: 7_400,
        firstDirtyHostTimeMs: 6_600,
        reason: "maintenance-drain",
        type: "settlement-success",
        windowId: 5,
      },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("restarts an immediate flush retry after rejection", async () => {
  const events: SettlementSchedulerEvent[] = [];
  const settlements: DeferredSettlement[] = [];
  const scheduler = createSettlementScheduler({
    clearTimer: () => undefined,
    hardTriggerMs: SETTLEMENT_END_TO_END_MAX_MS - 1,
    now: () => 50,
    onEvent: (event) => events.push(event),
    setTimer: () => 0,
    settle: (reason) => {
      const settlement = createDeferredSettlement(reason);
      settlements.push(settlement);
      return settlement.promise;
    },
  });

  scheduler.markDirty(10);
  const firstFlush = scheduler.flush("orderly-shutdown");
  let retryFlush: Promise<void> | undefined;
  const firstFailure = firstFlush.catch((error: unknown) => {
    retryFlush = scheduler.flush("maintenance-drain");
    return error;
  });

  const failure = new Error("first flush failed");
  settlements[0]!.reject(failure);
  await expect(firstFailure).resolves.toBe(failure);
  await vi.waitFor(() => expect(settlements).toHaveLength(2));
  expect(
    events
      .filter((event) => event.type === "settlement-start")
      .map(({ firstDirtyHostTimeMs, windowId }) => ({
        firstDirtyHostTimeMs,
        windowId,
      })),
  ).toEqual([
    { firstDirtyHostTimeMs: 10, windowId: 1 },
    { firstDirtyHostTimeMs: 10, windowId: 1 },
  ]);

  settlements[1]!.resolve();
  await expect(retryFlush).resolves.toBeUndefined();
});

it("uses host receipt order and deadlines when timer delivery is late", async () => {
  const reorderedClock = createManualClock(200);
  const reorderedEvents: SettlementSchedulerEvent[] = [];
  const reorderedSettlements: SettlementReason[] = [];
  const reorderedScheduler = createSettlementScheduler({
    ...reorderedClock,
    hardTriggerMs: SETTLEMENT_END_TO_END_MAX_MS - 1,
    onEvent: (event) => reorderedEvents.push(event),
    settle: (reason) => {
      reorderedSettlements.push(reason);
    },
  });

  reorderedScheduler.markDirty(100);
  reorderedScheduler.markDirty(0);
  reorderedClock.set(899);
  reorderedClock.runDueTimers();
  expect.soft(reorderedSettlements).toHaveLength(0);

  reorderedClock.set(900);
  reorderedClock.runDueTimers();
  await vi.waitFor(() => expect(reorderedEvents).toContainEqual(
    expect.objectContaining({ type: "settlement-success" }),
  ));
  expect.soft(reorderedSettlements).toEqual(["quiet"]);
  expect.soft(
    reorderedEvents.find((event) => event.type === "trigger"),
  ).toEqual({
    eventTimeMs: 900,
    firstDirtyHostTimeMs: 0,
    reason: "quiet",
    type: "trigger",
    windowId: 1,
  });

  const delayedClock = createManualClock();
  const delayedEvents: SettlementSchedulerEvent[] = [];
  const delayedSettlements: SettlementReason[] = [];
  const delayedScheduler = createSettlementScheduler({
    ...delayedClock,
    hardTriggerMs: SETTLEMENT_END_TO_END_MAX_MS - 1,
    onEvent: (event) => delayedEvents.push(event),
    settle: (reason) => {
      delayedSettlements.push(reason);
    },
  });

  delayedScheduler.markDirty(0);
  delayedClock.set(900);
  delayedScheduler.markDirty(900);
  await vi.waitFor(() => expect(delayedEvents).toContainEqual(
    expect.objectContaining({ type: "settlement-success" }),
  ));

  expect.soft(
    delayedEvents
      .filter((event) => event.type === "window-open")
      .map(({ firstDirtyHostTimeMs, windowId }) => ({
        firstDirtyHostTimeMs,
        windowId,
      })),
  ).toEqual([
    { firstDirtyHostTimeMs: 0, windowId: 1 },
    { firstDirtyHostTimeMs: 900, windowId: 2 },
  ]);
  expect.soft(
    delayedEvents.find((event) => event.type === "trigger"),
  ).toEqual({
    eventTimeMs: 900,
    firstDirtyHostTimeMs: 0,
    reason: "quiet",
    type: "trigger",
    windowId: 1,
  });
  expect.soft(delayedSettlements).toEqual(["quiet"]);
});

it("keeps settlement truth when trigger and success event sinks throw", async () => {
  const triggerEvents: SettlementSchedulerEvent["type"][] = [];
  let triggerSettlementCalls = 0;
  const triggerScheduler = createSettlementScheduler({
    clearTimer: () => undefined,
    hardTriggerMs: SETTLEMENT_END_TO_END_MAX_MS - 1,
    now: () => 0,
    onEvent: (event) => {
      triggerEvents.push(event.type);
      if (event.type === "trigger") throw new Error("trigger sink failed");
    },
    setTimer: () => 0,
    settle: () => {
      triggerSettlementCalls += 1;
    },
  });

  triggerScheduler.markDirty(0);
  let triggerFlush: Promise<void> | undefined;
  expect.soft(() => {
    triggerFlush = triggerScheduler.flush("orderly-shutdown");
  }).not.toThrow();
  if (triggerFlush !== undefined) {
    await expect.soft(triggerFlush).resolves.toBeUndefined();
  }
  expect.soft(triggerSettlementCalls).toBe(1);

  const successEvents: SettlementSchedulerEvent["type"][] = [];
  const successScheduler = createSettlementScheduler({
    clearTimer: () => undefined,
    hardTriggerMs: SETTLEMENT_END_TO_END_MAX_MS - 1,
    now: () => 0,
    onEvent: (event) => {
      successEvents.push(event.type);
      if (event.type === "settlement-success") {
        throw new Error("success sink failed");
      }
    },
    setTimer: () => 0,
    settle: () => undefined,
  });

  successScheduler.markDirty(0);
  const successOutcome = await successScheduler
    .flush("orderly-shutdown")
    .then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
  expect.soft(successOutcome).toBe("resolved");
  expect.soft(successEvents).not.toContain("settlement-failure");
});

it("bounds catch-up to one head and one coalescing tail", async () => {
  const heldClock = createManualClock();
  const heldEvents: SettlementSchedulerEvent[] = [];
  const heldSettlements: DeferredSettlement[] = [];
  const heldScheduler = createSettlementScheduler({
    ...heldClock,
    hardTriggerMs: 1,
    onEvent: (event) => heldEvents.push(event),
    settle: (reason) => {
      const settlement = createDeferredSettlement(reason);
      heldSettlements.push(settlement);
      return settlement.promise;
    },
  });

  heldScheduler.markDirty(0);
  heldClock.set(1);
  heldClock.runDueTimers();
  await vi.waitFor(() => expect(heldSettlements).toHaveLength(1));

  for (let hostReceivedAtMs = 2; hostReceivedAtMs <= 20; hostReceivedAtMs += 1) {
    heldClock.set(hostReceivedAtMs);
    heldScheduler.markDirty(hostReceivedAtMs);
    heldClock.runDueTimers();
  }

  expect.soft(
    heldEvents.filter((event) => event.type === "window-open"),
  ).toHaveLength(2);
  const heldFlush = heldScheduler.flush("maintenance-drain");
  heldSettlements[0]!.resolve();
  await heldSettlements[0]!.promise;
  await vi.waitFor(() => expect(heldSettlements).toHaveLength(2));
  heldSettlements[1]!.resolve();
  await heldFlush;
  expect.soft(heldSettlements).toHaveLength(2);

  const failedClock = createManualClock();
  const failedEvents: SettlementSchedulerEvent[] = [];
  const failedSettlements: DeferredSettlement[] = [];
  const failedScheduler = createSettlementScheduler({
    ...failedClock,
    hardTriggerMs: 1,
    onEvent: (event) => failedEvents.push(event),
    settle: (reason) => {
      const settlement = createDeferredSettlement(reason);
      failedSettlements.push(settlement);
      return settlement.promise;
    },
  });

  failedScheduler.markDirty(0);
  failedClock.set(1);
  failedClock.runDueTimers();
  const headFailure = new Error("head failed");
  failedSettlements[0]!.reject(headFailure);
  await expect(failedSettlements[0]!.promise).rejects.toBe(headFailure);
  await vi.waitFor(() => expect(failedEvents).toContainEqual(
    expect.objectContaining({ type: "settlement-failure" }),
  ));

  for (let hostReceivedAtMs = 2; hostReceivedAtMs <= 20; hostReceivedAtMs += 1) {
    failedClock.set(hostReceivedAtMs);
    failedScheduler.markDirty(hostReceivedAtMs);
    failedClock.runDueTimers();
  }

  expect.soft(
    failedEvents.filter((event) => event.type === "window-open"),
  ).toHaveLength(2);
  const failedFlush = failedScheduler.flush("maintenance-drain");
  await vi.waitFor(() => expect(failedSettlements).toHaveLength(2));
  failedSettlements[1]!.resolve();
  await failedSettlements[1]!.promise;
  await vi.waitFor(() => expect(failedSettlements).toHaveLength(3));
  failedSettlements[2]!.resolve();
  await failedFlush;
  expect.soft(failedSettlements).toHaveLength(3);
});
