import { afterEach, expect, it, vi } from "vitest";
import { createAppEventWaits } from "./appEventWaits";
import { hasRelayWriteObservers, notifyRelayWrite } from "./relayWriteChanges";

afterEach(() => {
  vi.useRealTimers();
});

const watching = (...datasetIds: string[]) => ({
  workspaceId: "w",
  since: datasetIds.map((datasetId) => ({ datasetId, revision: 1 })),
  holdMs: 20_000,
});

it("caps parked polls per link grant and per signed-in person, and hears writes only while one waits", async () => {
  const storage = {};
  const waits = createAppEventWaits(storage, () => 1, {
    maxTotal: 8,
    maxPerGroup: 8,
    maxPerActor: 2,
  });
  const stop = new AbortController();
  const wait = (actor: string, ...datasetIds: string[]) =>
    waits.wait({ ...watching(...datasetIds), actor, signal: stop.signal });
  const held = [wait("link:g", "d"), wait("link:g", "d", "e")];
  expect(hasRelayWriteObservers(storage)).toBe(true);
  await expect(wait("link:g", "e")).rejects.toMatchObject({ code: "link_read_rate_limited" });
  const others = [wait("named:w:ana", "d", "e"), wait("named:w:ana", "e")];
  await expect(wait("named:w:ana", "d")).rejects.toMatchObject({
    code: "link_read_rate_limited",
  });
  stop.abort();
  await Promise.all([...held, ...others]);
  expect(hasRelayWriteObservers(storage)).toBe(false);
});

it("wakes a poll when any Collection it watches moves within 250 ms of a write, reading each once, and every poll within a second", async () => {
  vi.useFakeTimers();
  const storage = {};
  const revisions = new Map([
    ["d", 1],
    ["e", 1],
    ["f", 1],
  ]);
  const reads = vi.fn((_: string, datasetId: string) => revisions.get(datasetId)!);
  const waits = createAppEventWaits(storage, reads);
  const signal = new AbortController().signal;
  const woke: string[] = [];
  const wait = (...datasetIds: string[]) =>
    waits
      .wait({ ...watching(...datasetIds), actor: "link:g", signal })
      .then(() => woke.push(datasetIds.join("+")));
  void wait("d", "e");
  void wait("f");
  await vi.advanceTimersByTimeAsync(1_000);
  notifyRelayWrite(storage);
  await vi.advanceTimersByTimeAsync(0);
  expect(woke.sort()).toEqual(["d+e", "f"]);
  woke.length = 0;
  void wait("d", "e");
  void wait("e", "d");
  void wait("e", "f");
  void wait("f");
  revisions.set("e", 2);
  for (let n = 0; n < 20; n += 1) notifyRelayWrite(storage);
  await vi.advanceTimersByTimeAsync(0);
  expect(woke).toEqual([]);
  const sweeps = reads.mock.calls.length;
  await vi.advanceTimersByTimeAsync(250);
  expect(woke.sort()).toEqual(["d+e", "e+d", "e+f"]);
  expect(reads.mock.calls.length - sweeps).toBeLessThanOrEqual(3);
  await vi.advanceTimersByTimeAsync(750);
  expect(woke.sort()).toEqual(["d+e", "e+d", "e+f", "f"]);
});
