import { describe, expect, it } from "vitest";
import { runInKeyedLane } from "./keyedLane";

function deferredVoid(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("runInKeyedLane", () => {
  it("runs operations for one key in FIFO order", async () => {
    const lanes = new Map<string, Promise<void>>();
    const firstStarted = deferredVoid();
    const finishFirst = deferredVoid();
    const secondStarted = deferredVoid();
    const finishSecond = deferredVoid();
    const order: string[] = [];

    const first = runInKeyedLane(lanes, "workspace", async () => {
      order.push("first:start");
      firstStarted.resolve();
      await finishFirst.promise;
      order.push("first:end");
    });
    await firstStarted.promise;

    const second = runInKeyedLane(lanes, "workspace", async () => {
      order.push("second:start");
      secondStarted.resolve();
      await finishSecond.promise;
      order.push("second:end");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    finishFirst.resolve();
    await first;
    await secondStarted.promise;
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(lanes.size).toBe(1);

    finishSecond.resolve();
    await second;
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(lanes.size).toBe(0);
  });

  it("runs different keys independently", async () => {
    const lanes = new Map<string, Promise<void>>();
    const finishFirst = deferredVoid();
    const finishSecond = deferredVoid();
    const firstStarted = deferredVoid();
    const secondStarted = deferredVoid();

    const first = runInKeyedLane(lanes, "first", async () => {
      firstStarted.resolve();
      await finishFirst.promise;
    });
    await firstStarted.promise;
    const second = runInKeyedLane(lanes, "second", async () => {
      secondStarted.resolve();
      await finishSecond.promise;
    });

    await secondStarted.promise;
    expect(lanes.size).toBe(2);
    finishFirst.resolve();
    finishSecond.resolve();
    await Promise.all([first, second]);
    expect(lanes.size).toBe(0);
  });

  it("continues a lane after the preceding operation rejects", async () => {
    const lanes = new Map<string, Promise<void>>();
    const firstStarted = deferredVoid();
    const failFirst = deferredVoid();
    const secondStarted = deferredVoid();

    const first = runInKeyedLane(lanes, "workspace", async () => {
      firstStarted.resolve();
      await failFirst.promise;
      throw new Error("failed");
    });
    await firstStarted.promise;
    const second = runInKeyedLane(lanes, "workspace", async () => {
      secondStarted.resolve();
      return "recovered";
    });

    failFirst.resolve();
    await expect(first).rejects.toThrow("failed");
    await secondStarted.promise;
    await expect(second).resolves.toBe("recovered");
    expect(lanes.size).toBe(0);
  });
});
