import { describe, expect, it, vi } from "vitest";
import { countersPerSaveConfirmation, createProfileCounters, profileCountersDelta } from "./profileCounters";

describe("profile counters", () => {
  it("retains no snapshot and calls no clock while disabled", () => {
    const now = vi.fn(() => 42);
    const counters = createProfileCounters(now);
    counters.add("mainHashBytes", 100);
    expect(counters.start()).toBeNull();
    counters.finish("mainHashDurationMs", null);
    expect(counters.snapshot()).toBeNull();
    expect(now).not.toHaveBeenCalled();
  });

  it("keeps independent raw snapshots and monotonic deltas", () => {
    let time = 10;
    const counters = createProfileCounters(() => time);
    counters.enable();
    const before = counters.snapshot()!;
    const start = counters.start();
    counters.add("mainHashBytes", 7);
    time = 14;
    counters.finish("mainHashDurationMs", start);
    counters.enable();
    const after = counters.snapshot()!;
    expect(before.mainHashBytes).toBe(0);
    expect(after.mainHashBytes).toBe(7);
    expect(profileCountersDelta(before, after)?.mainHashDurationMs).toBe(4);
    expect(profileCountersDelta(null, after)).toBeNull();
    expect(() => profileCountersDelta(after, before)).toThrow(/Invalid profiling counter delta/);
    after.mainHashBytes = Number.NaN;
    expect(() => profileCountersDelta(before, after)).toThrow(/Invalid profiling counter delta/);
  });

  it("does not infer per-save work when save confirmations are missing", () => {
    const counters = createProfileCounters();
    counters.enable();
    counters.add("leasePublications", 6);
    expect(countersPerSaveConfirmation(counters.snapshot(), 0)).toBeNull();
    expect(countersPerSaveConfirmation(null, 2)).toBeNull();
    expect(countersPerSaveConfirmation(counters.snapshot(), 2)?.leasePublications).toBe(3);
    expect(() => countersPerSaveConfirmation(counters.snapshot(), -1)).toThrow();
  });

  it("discards test counters without retaining values or calling clocks afterward", () => {
    const now = vi.fn(() => 42);
    const counters = createProfileCounters(now);
    counters.enable(); counters.add("sessionPublications");
    counters.resetForTests(); counters.add("leasePublications");
    expect(counters.start()).toBeNull();
    expect(counters.snapshot()).toBeNull();
    expect(now).not.toHaveBeenCalled();
    counters.enable();
    expect(counters.snapshot()?.sessionPublications).toBe(0);
  });
});
