import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub, ownerLogWaitGroup } from "./discussionActivity";
import { ReplicaWatchCapacityError, ReplicaWatches } from "./replicaWatches";

const registries: ReplicaWatches[] = [];
function registry(options: ConstructorParameters<typeof ReplicaWatches>[1] = {}) {
  const activity = new DiscussionActivityHub();
  const wake = vi.spyOn(activity, "wake");
  const watches = new ReplicaWatches(activity, options);
  registries.push(watches);
  return { watches, activity, wake };
}
afterEach(() => { for (const watches of registries.splice(0)) watches.dispose(); vi.useRealTimers(); });

describe("replica watches", () => {
  it("has no idle timer and expires without traffic, waking only on transitions", async () => {
    vi.useFakeTimers();
    const { watches, wake } = registry();
    expect(watches.watched("a")).toBe(false);
    expect(watches.stats()).toEqual({ workspaces: 0, holders: 0 });
    expect(vi.getTimerCount()).toBe(0);
    watches.hold("a", "one", 50);
    watches.hold("a", "two", 100);
    expect(wake.mock.calls).toEqual([[ownerLogWaitGroup("a")]]);
    await vi.advanceTimersByTimeAsync(50);
    expect(watches.stats()).toEqual({ workspaces: 1, holders: 1 });
    expect(wake).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(watches.stats()).toEqual({ workspaces: 0, holders: 0 });
    expect(wake.mock.calls).toEqual([[ownerLogWaitGroup("a")], [ownerLogWaitGroup("a")]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses both caps without eviction or allocation, but permits refresh", async () => {
    vi.useFakeTimers();
    const { watches, wake } = registry({ maxWorkspaces: 2, maxHoldersPerWorkspace: 2 });
    watches.hold("a", "one", 50);
    watches.hold("a", "two", 50);
    watches.hold("b", "one", 50);
    expect(() => watches.hold("a", "three", 50)).toThrow(ReplicaWatchCapacityError);
    expect(() => watches.hold("c", "one", 50)).toThrow(ReplicaWatchCapacityError);
    watches.hold("a", "one", 100);
    expect(watches.stats()).toEqual({ workspaces: 2, holders: 3 });
    expect(watches.watched("c")).toBe(false);
    expect(wake).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(watches.watched("a")).toBe(true);
    expect(watches.watched("b")).toBe(false);
    watches.hold("c", "one", 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(watches.stats()).toEqual({ workspaces: 0, holders: 0 });
  });

  it("releases only the named holder and workspace, reclaiming its timer", () => {
    vi.useFakeTimers();
    const { watches, wake } = registry();
    watches.hold("a", "same", 100);
    watches.hold("a", "other", 100);
    watches.hold("b", "same", 100);
    watches.release("a", "missing");
    watches.release("missing", "same");
    watches.release("a", "same");
    expect(watches.watched("a")).toBe(true);
    expect(wake).toHaveBeenCalledTimes(2);
    watches.release("a", "other");
    expect(watches.watched("a")).toBe(false);
    expect(watches.watched("b")).toBe(true);
    expect(wake.mock.calls.at(-1)).toEqual([ownerLogWaitGroup("a")]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("rejects invalid TTLs without creating a timer or state", () => {
    vi.useFakeTimers();
    const { watches } = registry();
    for (const ttl of [0, -1, NaN, Infinity, 1.5, 35_001]) {
      expect(() => watches.hold("a", "one", ttl)).toThrow(RangeError);
    }
    expect(watches.stats()).toEqual({ workspaces: 0, holders: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
