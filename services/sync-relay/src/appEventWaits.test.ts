import { afterEach, expect, it, vi } from "vitest";
import { createAppEventWaits } from "./appEventWaits";
import { hasRelayWriteObservers, notifyRelayWrite } from "./relayWriteChanges";

afterEach(() => {
  vi.useRealTimers();
});

const parked = { workspaceId: "w", datasetId: "d", since: 1, holdMs: 20_000 };

it("caps parked polls per link grant, and hears writes only while one waits", async () => {
  const storage = {};
  const waits = createAppEventWaits(storage, () => 1, {
    maxTotal: 8,
    maxPerGroup: 8,
    maxPerActor: 2,
  });
  const stop = new AbortController();
  const held = [1, 2].map(() => waits.wait({ ...parked, grantId: "g", signal: stop.signal }));
  expect(hasRelayWriteObservers(storage)).toBe(true);
  await expect(waits.wait({ ...parked, grantId: "g", signal: stop.signal })).rejects.toMatchObject({
    code: "link_read_rate_limited",
  });
  const other = waits.wait({ ...parked, grantId: "other", signal: stop.signal });
  stop.abort();
  await Promise.all([...held, other]);
  expect(hasRelayWriteObservers(storage)).toBe(false);
});

it("wakes a Collection whose revision moved within 250 ms of a write, and every poll within a second", async () => {
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
  const wait = (datasetId: string) =>
    waits.wait({ ...parked, datasetId, grantId: "g", signal }).then(() => woke.push(datasetId));
  void wait("d");
  void wait("e");
  await vi.advanceTimersByTimeAsync(1_000);
  notifyRelayWrite(storage);
  await vi.advanceTimersByTimeAsync(0);
  expect(woke.sort()).toEqual(["d", "e"]);
  woke.length = 0;
  for (const datasetId of ["d", "e", "f"]) void wait(datasetId);
  revisions.set("d", 2);
  for (let n = 0; n < 20; n += 1) notifyRelayWrite(storage);
  await vi.advanceTimersByTimeAsync(0);
  expect(woke).toEqual([]);
  const sweeps = reads.mock.calls.length;
  await vi.advanceTimersByTimeAsync(250);
  expect(woke).toEqual(["d"]);
  expect(reads.mock.calls.length - sweeps).toBeLessThanOrEqual(3);
  revisions.set("e", 2);
  notifyRelayWrite(storage);
  await vi.advanceTimersByTimeAsync(250);
  expect(woke).toEqual(["d", "e"]);
  await vi.advanceTimersByTimeAsync(500);
  expect(woke).toEqual(["d", "e", "f"]);
});
