import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localUsageDay, UsageSnapshot, type UsageSnapshot as Snapshot } from "@dohc/workspace-contracts/usage";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "../workspaces/testTemp";
import { createUsageStore, USAGE_SNAPSHOT_NAME, type UsageFileSystem } from "./usageStore";

const pair = { capabilityId: "version.try", door: "renderer" } as const;
const stores: ReturnType<typeof createUsageStore>[] = [];
const today = () => localUsageDay(new Date());
const query = () => ({ from: today(), through: today(), pairs: [pair] });

function memoryStore(initial?: Snapshot) {
  const path = join("isolated-state", USAGE_SNAPSHOT_NAME);
  const disk = new Map<string, string>(initial ? [[path, JSON.stringify(initial)]] : []);
  const io = {
    readFile: vi.fn(async (path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return text;
    }),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, data: string) => { disk.set(path, data); }),
    rename: vi.fn(async (from: string, to: string) => { disk.set(to, disk.get(from)!); disk.delete(from); }),
    rm: vi.fn(async (path: string) => { disk.delete(path); }),
  } satisfies UsageFileSystem;
  const stateDir = vi.fn(() => "isolated-state");
  const onWriteFailure = vi.fn();
  const store = createUsageStore({ stateDir, appVersion: "0.1.0", io, onWriteFailure });
  stores.push(store);
  return { store, io, disk, path, stateDir, onWriteFailure,
    saved: () => UsageSnapshot.parse(JSON.parse(disk.get(path)!)) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 7, 12));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.useRealTimers();
});

describe("local usage store", () => {
  it("loads once lazily, defaults On, and leaves all doors explicitly uncovered", async () => {
    const { store, io, stateDir } = memoryStore();
    expect(store.recordSuccess(pair)).toBe(false);
    expect(stateDir).not.toHaveBeenCalled();
    expect(io.readFile).not.toHaveBeenCalled();
    await Promise.all([store.load(), store.load()]);
    expect(io.readFile).toHaveBeenCalledTimes(1);
    expect((await store.read()).enabled).toBe(true);
    const rows = await store.query({ ...query(), pairs: [pair,
      { capabilityId: "file.list", door: "mcp" }, { capabilityId: "file.read", door: "mcp" },
      { capabilityId: "file.search", door: "mcp" }, { capabilityId: "workspace.list", door: "mcp" },
      { capabilityId: "version.try", door: "automation" }] });
    expect(rows.every(row => row.total === null && row.daily[0]!.status === "uncovered")).toBe(true);
    expect(vi.getTimerCount()).toBe(2);
  });

  it("accepts only aggregate success inputs and distinguishes a measured zero", async () => {
    const { store } = memoryStore();
    await store.load();
    expect(store.setCoverage({ capabilityId: "notice.list", door: "renderer", status: "covered" })).toBe(false);
    expect(store.setCoverage({ ...pair, status: "covered", path: "private" })).toBe(false);
    expect(store.setCoverage({ ...pair, status: "covered" })).toBe(true);
    expect((await store.query(query()))[0]!.total).toBe(0);
    for (const input of [{ ...pair, content: "private" }, { capabilityId: "version.list", door: "renderer" },
      { ...pair, door: "network" }, { ...pair, count: 99 }]) expect(store.recordSuccess(input)).toBe(false);
    expect(store.recordSuccess(pair)).toBe(true);
    expect(store.recordSuccess({ ...pair, door: "mcp" })).toBe(true);
    const snapshot = await store.read();
    expect(snapshot.counts.map(row => row.count)).toEqual([1, 1]);
    snapshot.counts[0]!.count = 100;
    expect((await store.read()).counts[0]!.count).toBe(1);
  });

  it("batches increments every 30 seconds, writes nothing while idle, and flushes once on exit", async () => {
    const { store, io, saved } = memoryStore();
    await store.load();
    for (let i = 0; i < 1_000; i++) store.recordSuccess(pair);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(io.writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(io.writeFile).toHaveBeenCalledTimes(1);
    expect(saved().counts[0]!.count).toBe(1_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(io.writeFile).toHaveBeenCalledTimes(1);
    store.recordSuccess(pair);
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await closing;
    expect(saved().counts[0]!.count).toBe(1_001);
    expect(io.writeFile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.recordSuccess(pair)).toBe(false);
  });

  it("keeps increments made while a snapshot is writing for the next batch", async () => {
    const { store, io, saved } = memoryStore();
    await store.load();
    store.recordSuccess(pair);
    const entered = deferred();
    const release = deferred();
    const rename = io.rename.getMockImplementation()!;
    io.rename.mockImplementationOnce(async (from, to) => { entered.resolve(); await release.promise; await rename(from, to); });
    const flushing = store.flush();
    await entered.promise;
    store.recordSuccess(pair);
    release.resolve();
    await flushing;
    expect(saved().counts[0]!.count).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saved().counts[0]!.count).toBe(2);
  });

  it("Off closes admission immediately, keeps counts across restart, and Clear keeps Off", async () => {
    const { store, io, disk, path, saved } = memoryStore();
    await store.load();
    store.setCoverage({ ...pair, status: "covered" });
    store.recordSuccess(pair);
    const off = store.setEnabled(false);
    expect(store.recordSuccess(pair)).toBe(false);
    await off;
    expect(saved()).toMatchObject({ enabled: false, counts: [{ count: 1 }] });
    await store.close();
    const restarted = createUsageStore({ stateDir: () => "isolated-state", appVersion: "0.2.0", io });
    stores.push(restarted);
    await restarted.load();
    expect(restarted.recordSuccess(pair)).toBe(false);
    expect((await restarted.read()).days[0]!.appVersions).toEqual(["0.1.0", "0.2.0"]);
    disk.set(path + ".tmp", "interrupted snapshot");
    await restarted.clear();
    expect(saved()).toMatchObject({ enabled: false, counts: [], coverage: [] });
    expect(disk.has(path + ".tmp")).toBe(false);
    await restarted.setEnabled(true);
    expect(restarted.recordSuccess(pair)).toBe(true);
    expect(restarted.setCoverage({ ...pair, status: "covered" })).toBe(false);
    expect((await restarted.query(query()))[0]!.total).toBeNull();
  });

  it("serializes Clear and Off behind an older snapshot without restoring cleared counts", async () => {
    const { store, io, saved, disk, path } = memoryStore();
    await store.load();
    store.recordSuccess(pair);
    const entered = deferred();
    const release = deferred();
    const rename = io.rename.getMockImplementation()!;
    io.rename.mockImplementationOnce(async (from, to) => { entered.resolve(); await release.promise; await rename(from, to); });
    const flush = store.flush();
    await entered.promise;
    const off = store.setEnabled(false);
    const clear = store.clear();
    expect(store.recordSuccess(pair)).toBe(false);
    release.resolve();
    await Promise.all([flush, off, clear]);
    expect(saved()).toMatchObject({ enabled: false, counts: [], coverage: [] });
    expect(disk.has(path + ".tmp")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saved().counts).toEqual([]);
  });

  it.each(["writeFile", "rename"] as const)("preserves the complete snapshot after %s fails and retries without losing increments", async method => {
    const { store, io, saved, onWriteFailure } = memoryStore();
    await store.load();
    store.setCoverage({ ...pair, status: "covered" });
    store.recordSuccess(pair);
    await store.flush();
    store.recordSuccess(pair);
    io[method].mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(store.flush()).rejects.toThrow("disk unavailable");
    expect(saved().counts[0]!.count).toBe(1);
    expect((await store.read()).counts[0]!.count).toBe(2);
    expect((await store.query(query()))[0]).toMatchObject({ total: null, observedCount: 2 });
    expect(store.setCoverage({ ...pair, status: "uncovered" })).toBe(false);
    expect(store.setCoverage({ ...pair, status: "covered" })).toBe(false);
    expect(onWriteFailure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(saved().counts[0]!.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved().counts[0]!.count).toBe(2);
  });

  it("does not acknowledge failed controls and lets Clear retry", async () => {
    const { store, io, saved } = memoryStore();
    await store.load();
    store.recordSuccess(pair);
    await store.flush();
    io.rename.mockRejectedValueOnce(new Error("failed Clear"));
    await expect(store.clear()).rejects.toThrow("failed Clear");
    expect(saved().counts).toHaveLength(1);
    await store.clear();
    expect(saved().counts).toEqual([]);
    expect(saved().enabled).toBe(true);
  });

  it("prunes at startup and each local midnight while Off", async () => {
    vi.setSystemTime(new Date(2026, 9, 7, 23, 59, 59));
    const initial: Snapshot = { version: 1, enabled: false,
      days: ["2026-07-09", "2026-07-10", today()].map(day => ({ day, appVersions: ["0.1.0"], collection: "off" })),
      counts: ["2026-07-09", "2026-07-10"].map(day => ({ ...pair, day, count: 1 })),
      coverage: [{ ...pair, day: "2026-07-09", status: "off" }] };
    const { store, saved } = memoryStore(initial);
    await store.load();
    expect((await store.read()).counts.map(row => row.day)).toEqual(["2026-07-10"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(today()).toBe("2026-10-08");
    expect((await store.read()).counts).toEqual([]);
    expect((await store.read()).days.at(-1)).toMatchObject({ day: today(), collection: "off" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saved().counts).toEqual([]);
    expect(saved().coverage).toEqual([]);
  });

  it("rolls over on an invocation after sleep and keeps separate local days", async () => {
    const { store } = memoryStore();
    await store.load();
    store.recordSuccess(pair);
    vi.setSystemTime(new Date(2026, 9, 8, 0, 1));
    store.recordSuccess(pair);
    expect((await store.read()).counts.map(row => row.day)).toEqual(["2026-10-07", "2026-10-08"]);
  });

  it("uses the last complete snapshot after an interrupted replacement and marks restart gaps", async () => {
    const { store, disk, path, io } = memoryStore();
    await store.load();
    store.setCoverage({ ...pair, status: "covered" });
    store.recordSuccess(pair);
    await store.flush();
    await store.close();
    disk.set(path + ".tmp", JSON.stringify({ ...JSON.parse(disk.get(path)!), counts: [{ ...pair, day: today(), count: 99 }] }));
    const restart = createUsageStore({ stateDir: () => "isolated-state", appVersion: "0.1.0", io });
    stores.push(restart);
    await restart.load();
    expect((await restart.query(query()))[0]).toMatchObject({ total: null, observedCount: 1 });
    expect(restart.setCoverage({ ...pair, status: "covered" })).toBe(false);
    await restart.clear();
    expect(disk.has(path + ".tmp")).toBe(false);
    expect(restart.setCoverage({ ...pair, status: "covered" })).toBe(false);
  });

  it("rejects corrupt snapshots instead of presenting their absence as zero", async () => {
    const { store, disk, path } = memoryStore();
    disk.set(path, '{"version":1,"content":"private"}');
    await expect(store.read()).rejects.toThrow();
    expect(store.recordSuccess(pair)).toBe(false);
    disk.delete(path);
    await store.load();
    expect((await store.query(query()))[0]!.total).toBeNull();
  });

  it("does not load unused state on exit and waits for an already pending load", async () => {
    const unused = memoryStore();
    await unused.store.close();
    expect(unused.io.readFile).not.toHaveBeenCalled();
    expect(unused.io.writeFile).not.toHaveBeenCalled();
    const pending = memoryStore();
    const read = deferred<string>();
    pending.io.readFile.mockImplementationOnce(() => read.promise);
    const load = pending.store.load();
    const close = pending.store.close();
    read.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await Promise.all([load, close]);
    expect(pending.io.writeFile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });


  it("does not let an old timer write within 30 seconds of a control flush", async () => {
    const { store, io } = memoryStore();
    await store.load();
    await vi.advanceTimersByTimeAsync(10_000);
    await store.setEnabled(false);
    expect(io.writeFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await store.setEnabled(true);
    expect(io.writeFile).toHaveBeenCalledTimes(2);
    store.recordSuccess(pair);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(io.writeFile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(io.writeFile).toHaveBeenCalledTimes(3);
  });

  it("bounds counts and marks saturation incomplete without overflowing", async () => {
    const initial: Snapshot = { version: 1, enabled: true,
      days: [{ day: today(), appVersions: ["0.1.0"], collection: "on" }],
      counts: [{ ...pair, day: today(), count: 2_147_483_647 }], coverage: [] };
    const { store } = memoryStore(initial);
    await store.load();
    store.setCoverage({ ...pair, status: "covered" });
    expect(store.recordSuccess(pair)).toBe(false);
    expect((await store.query(query()))[0]).toMatchObject({ total: null, observedCount: 2_147_483_647 });
    expect((await store.read()).counts[0]!.count).toBe(2_147_483_647);
  });

  it("does not mutate an injected local clock when calculating retention", async () => {
    const clock = new Date(2026, 9, 7, 12);
    const original = clock.getTime();
    const memory = memoryStore();
    const store = createUsageStore({ stateDir: () => "other-state", appVersion: "0.1.0", io: memory.io, now: () => clock });
    stores.push(store);
    await store.load();
    expect(clock.getTime()).toBe(original);
    expect((await store.read()).days[0]!.day).toBe("2026-10-07");
  });

  it("prunes all rows beyond 90 days after a long sleep while Off", async () => {
    const { store } = memoryStore();
    await store.load();
    store.recordSuccess(pair);
    await store.setEnabled(false);
    vi.setSystemTime(new Date(2027, 0, 6, 12));
    expect(store.recordSuccess(pair)).toBe(false);
    expect((await store.read()).counts).toEqual([]);
    expect((await store.read()).coverage).toEqual([]);
    expect((await store.read()).days).toEqual([{ day: "2027-01-06", appVersions: ["0.1.0"], collection: "off" }]);
  });

  it("writes and restarts independently in real isolated state directories", async () => {
    vi.useRealTimers();
    const firstDir = await createTestScratch("usage-first-");
    const secondDir = await createTestScratch("usage-second-");
    const make = (directory: string) => {
      const store = createUsageStore({ stateDir: () => directory, appVersion: "0.1.0" });
      stores.push(store);
      return store;
    };
    const first = make(firstDir);
    const second = make(secondDir);
    await Promise.all([first.load(), second.load()]);
    first.recordSuccess(pair);
    await Promise.all([first.close(), second.close()]);
    const restart = make(firstDir);
    expect((await restart.read()).counts[0]!.count).toBe(1);
    expect(JSON.parse(await fs.readFile(join(secondDir, USAGE_SNAPSHOT_NAME), "utf8")).counts).toEqual([]);
    await fs.writeFile(join(firstDir, USAGE_SNAPSHOT_NAME) + ".tmp", "private old snapshot");
    await restart.clear();
    await expect(fs.stat(join(firstDir, USAGE_SNAPSHOT_NAME) + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
    await restart.close();
  });
});
