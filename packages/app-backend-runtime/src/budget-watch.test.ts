import { expect, it, vi } from "vitest";
import {
  armBudget,
  budgetMarkerName,
  BUDGET_STATE_SLOTS,
  disarmBudget,
  memoryBudgetMarkerName,
  parseBudgetMarkerName,
  processPeakMemoryBytes,
  sqliteEnforcesHardHeapLimit,
  watchBudget,
} from "./budget-watch.ts";

it.each(["app", "checks"] as const)("round-trips the %s marker produced by the writer", (kind) => {
  const budgetMs = kind === "app" ? 1000 : 9000;
  expect(parseBudgetMarkerName(budgetMarkerName(kind, budgetMs))).toEqual({
    resource: "cpu",
    kind,
    budgetMs,
  });
});

it("round-trips the memory budget marker produced by the writer", () => {
  const limitBytes = 256 * 1024 * 1024;
  const usedBytes = 312 * 1024 * 1024;
  expect(parseBudgetMarkerName(memoryBudgetMarkerName(limitBytes, usedBytes))).toEqual({
    resource: "memory",
    limitBytes,
    usedBytes,
  });
});

it.each([
  "cpu-budget-exceeded",
  "cpu-budget-exceeded-other-1000",
  "cpu-budget-exceeded-appx",
  "cpu-budget-exceeded-app",
  "memory-budget-exceeded",
  "memory-budget-exceeded-268435456",
])("ignores an unsupported marker name: %s", (name) => {
  expect(parseBudgetMarkerName(name)).toBeUndefined();
});

it("detects whether SQLite compile options enforce hard_heap_limit", () => {
  expect(sqliteEnforcesHardHeapLimit(["THREADSAFE=1", "DEFAULT_MEMSTATUS=0"])).toBe(false);
  expect(sqliteEnforcesHardHeapLimit(["THREADSAFE=1", "ENABLE_SESSION"])).toBe(true);
});

it("uses /proc/self/status VmHWM on Linux instead of inherited parent maxRSS", () => {
  const pollutedParentMaxRssKiB = 350_000;
  expect(
    processPeakMemoryBytes(
      "linux",
      () => 42 * 1024 * 1024,
      () => pollutedParentMaxRssKiB,
      () => "Name:\tnode\nVmHWM:\t   48000 kB\nVmRSS:\t   43008 kB\n",
    ),
  ).toBe(48_000n * 1024n);
  expect(
    processPeakMemoryBytes(
      "linux",
      () => 60 * 1024 * 1024,
      () => pollutedParentMaxRssKiB,
      () => "VmHWM:\t   48000 kB\n",
    ),
  ).toBe(60n * 1024n * 1024n);
  expect(
    processPeakMemoryBytes(
      "linux",
      () => 42 * 1024 * 1024,
      () => pollutedParentMaxRssKiB,
      () => {
        throw new Error("EACCES");
      },
    ),
  ).toBe(42n * 1024n * 1024n);
  expect(
    processPeakMemoryBytes(
      "win32",
      () => 42 * 1024 * 1024,
      () => 120_000,
      () => {
        throw new Error("should not read procfs");
      },
    ),
  ).toBe(120_000n * 1024n);
});

it("arms the kill guard before a stalled marker create and ends the step within its grace period", () => {
  const state = new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS * 8));
  const section = armBudget(state, 1n, 0n, 1_000_000n);
  let guardArmed = false;
  vi.useFakeTimers();
  const schedule = setTimeout;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((...args: Parameters<typeof setTimeout>) => {
      guardArmed = true;
      return schedule(...args);
    });
  const kill = vi.fn();
  const create = vi.fn(() => {
    expect(guardArmed).toBe(true);
    return new Promise(() => {});
  });
  const stop = watchBudget(
    state,
    () => 2_000_000n,
    () => 0n,
    create,
    kill,
    50,
    250,
  );
  try {
    vi.advanceTimersByTime(50);
    expect(create).toHaveBeenCalledOnce();
    expect(timer).toHaveBeenCalledOnce();
    expect(disarmBudget(state, section, 2_000_000n)).toBe(false);
    vi.advanceTimersByTime(249);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledOnce();
  } finally {
    stop();
    timer.mockRestore();
    vi.useRealTimers();
  }
});

it("tells the host which budget ran out when the marker write finishes", async () => {
  const state = new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS * 8));
  const reasons: string[] = [];
  let killed = false;
  armBudget(state, 2n, 0n, 9_000_000n);
  const stop = watchBudget(
    state,
    () => 10_000_000n,
    () => 0n,
    async (exceeded) => {
      reasons.push(
        exceeded.resource === "cpu"
          ? budgetMarkerName(exceeded.kind, exceeded.budgetMs)
          : memoryBudgetMarkerName(exceeded.limitBytes, exceeded.usedBytes),
      );
    },
    () => {
      killed = true;
    },
    1,
    60_000,
  );
  try {
    await vi.waitFor(() => expect(killed).toBe(true), { timeout: 10_000 });
    expect(reasons).toEqual(["cpu-budget-exceeded-checks-9000"]);
  } finally {
    stop();
  }
});

it("condemns a budgeted step when worker memory crosses its limit and leaves unarmed steps alone", async () => {
  const state = new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS * 8));
  const limit = 256n * 1024n * 1024n;
  const used = 300n * 1024n * 1024n;
  const reasons: string[] = [];
  let killed = false;
  vi.useFakeTimers();
  const stop = watchBudget(
    state,
    () => 100n,
    () => used,
    (exceeded) => {
      reasons.push(
        exceeded.resource === "memory"
          ? memoryBudgetMarkerName(exceeded.limitBytes, exceeded.usedBytes)
          : budgetMarkerName(exceeded.kind, exceeded.budgetMs),
      );
      return Promise.resolve();
    },
    () => {
      killed = true;
    },
    25,
    60_000,
  );
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(killed).toBe(false);
    const section = armBudget(state, 1n, 0n, 5_000_000n, limit);
    expect(disarmBudget(state, section, 100n, used)).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect(killed).toBe(true);
    expect(reasons).toEqual([memoryBudgetMarkerName(Number(limit), Number(used))]);
  } finally {
    stop();
    vi.useRealTimers();
  }
});

it("allows disarmBudget when memory enforcement is disabled (0) or within limit", () => {
  const state = new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS * 8));
  const first = armBudget(state, 1n, 0n, 5_000_000n, 0n);
  expect(disarmBudget(state, first, 100n, 512n * 1024n * 1024n)).toBe(true);
  const second = armBudget(state, 1n, 0n, 5_000_000n, 256n * 1024n * 1024n);
  expect(disarmBudget(state, second, 100n, 256n * 1024n * 1024n)).toBe(true);
});
