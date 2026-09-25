import { expect, it, vi } from "vitest";
import { armBudget, BUDGET_STATE_SLOTS, disarmBudget, watchBudget } from "./budget-watch.ts";

it("ends a step over its budget without waiting for a blocked marker write, and refuses the step's result", async () => {
  const state = new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS * 8));
  let cpu = 0n, killed = false;
  const section = armBudget(state, 1n, 0n, 1_000n);
  // The marker write never finishes, as on a stalled disk.
  const stop = watchBudget(state, () => cpu, () => new Promise(() => {}), () => { killed = true; }, 1, 20);
  try {
    cpu = 2_000n;
    await vi.waitFor(() => expect(killed).toBe(true), { timeout: 10_000 });
    expect(disarmBudget(state, section)).toBe(false);
  } finally { stop(); }
});

it("tells the host which budget ran out when the marker write finishes", async () => {
  const state = new BigInt64Array(new SharedArrayBuffer(BUDGET_STATE_SLOTS * 8));
  const reasons: string[] = [];
  let killed = false;
  armBudget(state, 2n, 0n, 9_000_000n);
  const stop = watchBudget(state, () => 10_000_000n, async reason => { reasons.push(reason); }, () => { killed = true; }, 1, 60_000);
  try {
    await vi.waitFor(() => expect(killed).toBe(true), { timeout: 10_000 });
    expect(reasons).toEqual(["checks 9000"]);
  } finally { stop(); }
});
