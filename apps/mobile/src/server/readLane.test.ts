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
});
