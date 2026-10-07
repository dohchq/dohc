import { expect, it, vi } from "vitest";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armBudget, budgetMarkerName, BUDGET_STATE_SLOTS, disarmBudget, parseBudgetMarkerName, watchBudget } from "./budget-watch.ts";

it.each(["app","checks"] as const)("round-trips the %s marker produced by the writer", kind => {
  const budgetMs=kind==="app" ? 1000 : 9000;
  expect(parseBudgetMarkerName(budgetMarkerName(kind,budgetMs))).toEqual({kind,budgetMs});
});

it.each(["cpu-budget-exceeded","cpu-budget-exceeded-other-1000","cpu-budget-exceeded-app"])("ignores an unsupported marker name: %s", name => {
  expect(parseBudgetMarkerName(name)).toBeUndefined();
});

it("creates the marker before arming the kill timer or killing the worker", () => {
  const directory=mkdtempSync(join(tmpdir(),"dohc-budget-marker-"));
  const marker=join(directory,budgetMarkerName("app",1000));
  const state=new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS*8));
  vi.useFakeTimers();
  const schedule=setTimeout;
  const timer=vi.spyOn(globalThis,"setTimeout").mockImplementation((...args:Parameters<typeof setTimeout>)=>{
    expect(existsSync(marker)).toBe(true);
    return schedule(...args);
  });
  const kill=vi.fn(()=>{expect(existsSync(marker)).toBe(true);});
  armBudget(state,1n,0n,1_000_000n);
  const stop=watchBudget(state,()=>2_000_000n,(kind,budgetMs)=>{
    closeSync(openSync(join(directory,budgetMarkerName(kind,budgetMs)),"wx"));
    return new Promise(()=>{});
  },kill,50,250);
  try {
    vi.advanceTimersByTime(50);
    expect(timer).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(250);
    expect(kill).toHaveBeenCalledOnce();
  } finally {
    stop();timer.mockRestore();vi.useRealTimers();
    rmSync(directory,{recursive:true,force:true});
  }
});

it("ends a step over its budget without waiting for a blocked marker completion, and refuses the step's result", async () => {
  const state = new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS * 8));
  let cpu = 0n, killed = false;
  const section = armBudget(state, 1n, 0n, 1_000n);
  // The marker completion promise never settles.
  const stop = watchBudget(state, () => cpu, () => new Promise(() => {}), () => { killed = true; }, 1, 20);
  try {
    cpu = 2_000n;
    await vi.waitFor(() => expect(killed).toBe(true), { timeout: 10_000 });
    expect(disarmBudget(state, section, cpu)).toBe(false);
  } finally { stop(); }
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
