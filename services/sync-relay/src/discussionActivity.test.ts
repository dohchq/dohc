import { describe, expect, it } from "vitest";
import {
  DiscussionActivityCapacityError,
  DiscussionActivityHub,
} from "./discussionActivity";

describe("DiscussionActivityHub", () => {
  it("registers before the final storage check and releases on wake", async () => {
    const hub = new DiscussionActivityHub();
    const waiting = hub.wait("share-a", "actor-a", {
      holdMs: 60_000,
      shouldPark: () => {
        expect(hub.stats()).toEqual({ shares: 1, waiters: 1 });
        hub.wake("share-a");
        return true;
      },
    });
    await waiting;
    expect(hub.stats()).toEqual({ shares: 0, waiters: 0 });
  });

  it("bounds total, per-share, and per-actor waiters without allocating overflow", async () => {
    const hub = new DiscussionActivityHub({
      maxTotalWaiters: 3,
      maxWaitersPerShare: 2,
      maxWaitersPerActor: 1,
    });
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ];
    const first = hub.wait("share-a", "actor-a", {
      holdMs: 60_000,
      signal: controllers[0]!.signal,
      shouldPark: () => true,
    });
    expect(() =>
      hub.wait("share-b", "actor-a", {
        holdMs: 60_000,
        shouldPark: () => true,
      }),
    ).toThrow(DiscussionActivityCapacityError);
    const second = hub.wait("share-a", "actor-b", {
      holdMs: 60_000,
      signal: controllers[1]!.signal,
      shouldPark: () => true,
    });
    expect(() =>
      hub.wait("share-a", "actor-c", {
        holdMs: 60_000,
        shouldPark: () => true,
      }),
    ).toThrow(DiscussionActivityCapacityError);
    const third = hub.wait("share-b", "actor-c", {
      holdMs: 60_000,
      signal: controllers[2]!.signal,
      shouldPark: () => true,
    });
    expect(() =>
      hub.wait("share-c", "actor-d", {
        holdMs: 60_000,
        shouldPark: () => true,
      }),
    ).toThrow(DiscussionActivityCapacityError);
    expect(hub.stats()).toEqual({ shares: 2, waiters: 3 });
    controllers[0]!.abort();
    controllers[1]!.abort();
    controllers[2]!.abort();
    await Promise.all([first, second, third]);
    expect(hub.stats()).toEqual({ shares: 0, waiters: 0 });
  });

  it("releases a timed-out waiter", async () => {
    const hub = new DiscussionActivityHub({ maxTotalWaiters: 1 });
    await hub.wait("share-a", "actor-a", {
      holdMs: 1,
      shouldPark: () => true,
    });
    expect(hub.stats()).toEqual({ shares: 0, waiters: 0 });
  });
});
