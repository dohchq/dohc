import { expect, it, vi } from "vitest";
import { createTypingCheckpointWriter } from "./typingCheckpointWriter";

it("drops the queued older snapshot after a synchronous session-end write", async () => {
  const gate = Promise.withResolvers<void>();
  let disk = "";
  const stored = vi.fn();
  const write = vi.fn(async (snapshot: string) => {disk = snapshot; await gate.promise;});
  const writer = createTypingCheckpointWriter({write, writeSync: snapshot => {disk = snapshot;}, retire: async () => {}, stored});
  const first = writer.flush("W1");
  const queued = writer.flush("W2");
  writer.flushSync("S");
  await Promise.all([first, queued]);
  gate.resolve();
  await writer.idle();
  expect(write).toHaveBeenCalledExactlyOnceWith("W1");
  expect(disk).toBe("S");
  expect(stored.mock.calls).toEqual([["S"]]);
});

it("tracks A on disk when the newer B fails, and rejects B's flush", async () => {
  const gate = Promise.withResolvers<void>();
  const stored = vi.fn();
  let disk = "";
  const writer = createTypingCheckpointWriter({
    write: async (snapshot: string) => {
      if (snapshot === "B") throw Error("disk full");
      await gate.promise;
      disk = snapshot;
    }, retire: async () => {}, stored,
  });
  const first = writer.flush("A");
  const failure = expect(writer.flush("B")).rejects.toThrow("disk full");
  gate.resolve();
  await first;
  await failure;
  expect(disk).toBe("A");
  expect(stored.mock.calls).toEqual([["A"]]);
});

it("combines repeated timer ticks into one newest pending write", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<void>();
  const writes: string[] = [];
  const stored = vi.fn();
  const writer = createTypingCheckpointWriter({
    write: async (snapshot: string) => {writes.push(snapshot); if (snapshot === "initial") await gate.promise;},
    retire: async () => {}, stored,
  });
  const first = writer.flush("initial");
  let count = 0;
  let latest = first;
  const promises = new Set<Promise<void>>();
  const timer = setInterval(() => {latest = writer.flush(`typing ${++count}`); promises.add(latest);}, 100);
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toEqual(["initial"]);
    expect(promises.size).toBe(1);
    let finished = false;
    void latest.then(() => {finished = true;});
    expect(finished).toBe(false);
    gate.resolve();
    await latest;
    await first;
    expect(writes).toEqual(["initial", "typing 100"]);
    expect(stored).toHaveBeenLastCalledWith("typing 100");
  } finally {
    clearInterval(timer);
    gate.resolve();
    await writer.idle();
    vi.useRealTimers();
  }
});
