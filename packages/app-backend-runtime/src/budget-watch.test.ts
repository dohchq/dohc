import { expect, it, vi } from "vitest";
import { armBudget, budgetMarkerName, BUDGET_STATE_SLOTS, disarmBudget, parseBudgetMarkerName, watchBudget } from "./budget-watch.ts";

it.each(["app","checks"] as const)("round-trips the %s marker produced by the writer", kind => {
  const budgetMs=kind==="app" ? 1000 : 9000;
  expect(parseBudgetMarkerName(budgetMarkerName(kind,budgetMs))).toEqual({kind,budgetMs});
});

it.each(["cpu-budget-exceeded","cpu-budget-exceeded-other-1000","cpu-budget-exceeded-appx","cpu-budget-exceeded-app"])("ignores an unsupported marker name: %s", name => {
  expect(parseBudgetMarkerName(name)).toBeUndefined();
});

it("arms the kill guard before a stalled marker create and ends the step within its grace period", () => {
  const state=new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS*8));
  const section=armBudget(state,1n,0n,1_000_000n);
  let guardArmed=false;
  vi.useFakeTimers();
  const schedule=setTimeout;
  const timer=vi.spyOn(globalThis,"setTimeout").mockImplementation((...args:Parameters<typeof setTimeout>)=>{
    guardArmed=true;
    return schedule(...args);
  });
  const kill=vi.fn();
  const create=vi.fn(()=>{
    expect(guardArmed).toBe(true);
    // File creation never finishes, as on a stalled disk.
    return new Promise(()=>{});
  });
  const stop=watchBudget(state,()=>2_000_000n,create,kill,50,250);
  try {
    vi.advanceTimersByTime(50);
    expect(create).toHaveBeenCalledOnce();
    expect(timer).toHaveBeenCalledOnce();
    expect(disarmBudget(state,section,2_000_000n)).toBe(false);
    vi.advanceTimersByTime(249);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledOnce();
  } finally {
    stop();timer.mockRestore();vi.useRealTimers();
  }
});

it("tells the host which budget ran out when the marker write finishes", async () => {
  const state = new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS * 8));
  const reasons: string[] = [];
  let killed = false;
  armBudget(state, 2n, 0n, 9_000_000n);
  const stop = watchBudget(state, () => 10_000_000n, async (kind,budgetMs) => { reasons.push(budgetMarkerName(kind,budgetMs)); }, () => { killed = true; }, 1, 60_000);
  try {
    await vi.waitFor(() => expect(killed).toBe(true), { timeout: 10_000 });
    expect(reasons).toEqual(["cpu-budget-exceeded-checks-9000"]);
  } finally { stop(); }
});
