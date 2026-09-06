import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "./tokenBucketLimiter";
import { WaiterRegistry } from "./waiterRegistry";

describe("TokenBucketLimiter", () => {
  it("refills over time and evicts the oldest key at the cap", () => {
    const limiter = new TokenBucketLimiter(1, 1, 2);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 0)).toBe(false);
    expect(limiter.allow("a", 1_000)).toBe(true);
    expect(limiter.allow("b", 1_000)).toBe(true);
    expect(limiter.allow("c", 2_000)).toBe(true);
    expect(limiter.size).toBe(2);
    // "a" was the oldest and is gone; it starts a fresh bucket.
    expect(limiter.allow("a", 2_000)).toBe(true);
  });

  it("refuses non-positive limits", () => {
    expect(() => new TokenBucketLimiter(0, 1, 1)).toThrow(/positive/u);
  });
});

describe("WaiterRegistry", () => {
  it("caps total, per-group, and per-actor waiters and releases every slot", async () => {
    const registry = new WaiterRegistry<string>({ maxTotal: 3, maxPerGroup: 2, maxPerActor: 1 });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const park = (group: string, actor: string, signal?: AbortSignal) =>
      registry.park(group, actor, { holdMs: 60_000, signal, settle: () => "settled" });
    const first = park("a", "actor-a", controllers[0]!.signal);
    expect(registry.atCapacity("b", "actor-a")).toBe(true);
    const second = park("a", "actor-b", controllers[1]!.signal);
    expect(registry.atCapacity("a", "actor-c")).toBe(true);
    const third = park("b", "actor-c", controllers[2]!.signal);
    expect(registry.atCapacity("c", "actor-d")).toBe(true);
    expect(registry.stats()).toEqual({ groups: 2, waiters: 3 });
    registry.wake("a", "woken");
    expect(await first).toBe("woken");
    expect(await second).toBe("woken");
    controllers[2]!.abort();
    expect(await third).toBe("settled");
    expect(registry.stats()).toEqual({ groups: 0, waiters: 0 });
  });

  it("settles at once when shouldPark says the wait is already over", async () => {
    const registry = new WaiterRegistry({ maxTotal: 8, maxPerGroup: 8, maxPerActor: 8 });
    let seenRegistered = false;
    await registry.park("g", undefined, {
      holdMs: 60_000,
      settle: () => undefined,
      shouldPark: () => {
        seenRegistered = registry.waiting("g") === 1;
        return false;
      },
    });
    expect(seenRegistered).toBe(true);
    expect(registry.stats()).toEqual({ groups: 0, waiters: 0 });
  });

  it("releases a timed-out waiter", async () => {
    const registry = new WaiterRegistry<number>({ maxTotal: 8, maxPerGroup: 8, maxPerActor: 8 });
    expect(await registry.park("g", "actor", { holdMs: 1, settle: () => 42 })).toBe(42);
    expect(registry.stats()).toEqual({ groups: 0, waiters: 0 });
  });
});
