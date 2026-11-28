import { describe, expect, it } from "vitest";
import { readLane } from "./readLane";

describe("a sign-in's read lane", () => {
  it("frees its place when a read throws before it starts", async () => {
    const lane = readLane({});
    const thrown = lane.screen(() => {
      throw new Error("no client");
    }, true);
    await expect(thrown).rejects.toThrow("no client");
    expect(lane.free()).toBe(true);
  });

  it("aborts read-ahead at once when its store has already stopped", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const aborted = await readLane({}).ahead(stopped.signal, async (signal) => signal.aborted);
    expect(aborted).toBe(true);
  });

  it("promotes an in-flight read-ahead without aborting it, while aborting other read-aheads", async () => {
    const lane = readLane({});
    const store = new AbortController();
    let releaseFirst!: () => void;
    let firstSignal!: AbortSignal;
    let promoteFirst!: () => boolean;
    let secondSignal!: AbortSignal;
    const first = lane.ahead(
      store.signal,
      (signal, promote) =>
        new Promise<void>((resolve) => {
          firstSignal = signal;
          promoteFirst = promote;
          releaseFirst = resolve;
        }),
    );
    const second = lane.ahead(
      store.signal,
      (signal) =>
        new Promise<void>((resolve) => {
          secondSignal = signal;
          signal.addEventListener("abort", () => resolve());
        }),
    );
    expect(lane.free()).toBe(false);
    expect(promoteFirst()).toBe(true);
    expect(promoteFirst()).toBe(false);
    expect(firstSignal.aborted).toBe(false);
    expect(secondSignal.aborted).toBe(true);
    await second;
    expect(lane.free()).toBe(false);
    releaseFirst();
    await first;
    expect(lane.free()).toBe(true);
  });

  it("refuses promotion after a read-ahead settles or throws synchronously", async () => {
    const lane = readLane({});
    const store = new AbortController();
    let promoteAfter!: () => boolean;
    await lane.ahead(store.signal, async (_signal, promote) => {
      promoteAfter = promote;
    });
    expect(promoteAfter()).toBe(false);
    expect(lane.free()).toBe(true);

    let promoteThrown!: () => boolean;
    await expect(
      lane.ahead(store.signal, (_signal, promote) => {
        promoteThrown = promote;
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");
    expect(promoteThrown()).toBe(false);
    expect(lane.free()).toBe(true);
  });
});
