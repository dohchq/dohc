import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localUsageDay, UsageSnapshot, type UsageBuildPair, type UsageSnapshot as Snapshot } from "@dohc/workspace-contracts/usage";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "../workspaces/testTemp";
import { createUsageStore, USAGE_PENDING_LIMIT, USAGE_SNAPSHOT_NAME, USAGE_WRITE_INTERVAL_MS, type UsageFileSystem } from "./usageStore";

const pair = { capabilityId: "version.try", door: "renderer" } as const;
const mapping: UsageBuildPair[] = [{ ...pair, status: "covered" }];
const stores: ReturnType<typeof createUsageStore>[] = [];
const today = () => localUsageDay(new Date());
const query = () => ({ from: today(), through: today(), pairs: [pair] });
function seed(enabled = true): Snapshot {
  return { version: 1, enabled, cleanExit: true,
    days: [{ day: today(), appVersions: ["0.1.0"], complete: enabled }], counts: [],
    coverage: [{ appVersion: "0.1.0", pairs: mapping }] };
}
function memoryStore(initial: unknown = seed(), buildMapping = mapping) {
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
  const store = createUsageStore({ stateDir, appVersion: "0.1.0", coverage: buildMapping, io, onWriteFailure });
  stores.push(store);
  const restart = (appVersion = "0.1.0", coverage = buildMapping) => {
    const store = createUsageStore({ stateDir, appVersion, coverage, io });
    stores.push(store);
    return store;
  };
  return { store, io, disk, path, stateDir, onWriteFailure, restart,
    saved: () => UsageSnapshot.parse(JSON.parse(disk.get(path)!)) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12)); });
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); vi.useRealTimers(); });

describe("local usage store", () => {
  it("loads lazily once, defaults On, and leaves the uninstrumented build uncovered", async () => {
    const { store, io, stateDir } = memoryStore(null, []);
    expect(stateDir).not.toHaveBeenCalled();
    expect(io.readFile).not.toHaveBeenCalled();
    await Promise.all([store.load(), store.load()]);
    expect(io.readFile).toHaveBeenCalledTimes(1);
    expect((await store.read()).enabled).toBe(true);
    const rows = await store.query({ ...query(), pairs: [pair, { capabilityId: "file.list", door: "mcp" },
      { capabilityId: "file.read", door: "mcp" }, { capabilityId: "file.search", door: "mcp" },
      { capabilityId: "workspace.list", door: "mcp" }, { capabilityId: "version.try", door: "automation" }] });
    expect(rows.every(row => row.total === null && row.usedDays === null)).toBe(true);
  });
  it("rejects payloads and background ids, isolates snapshots, and keeps a measured zero", async () => {
    const { store } = memoryStore();
    await store.load();
    expect((await store.query(query()))[0]!.total).toBe(0);
    for (const input of [{ ...pair, content: "private" }, { capabilityId: "version.list", door: "renderer" },
      { ...pair, door: "network" }, { ...pair, count: 99 }]) expect(store.recordSuccess(input)).toBe(false);
    expect(store.recordSuccess(pair)).toBe(true);
    const snapshot = await store.read();
    snapshot.counts[0]!.count = 100;
    snapshot.coverage[0]!.pairs[0]!.status = "uncovered";
    expect((await store.query(query()))[0]!.total).toBe(1);
  });
  it("batches changed counts every 30 seconds, stays idle, and flushes once on exit", async () => {
    const { store, io, saved } = memoryStore();
    await store.load();
    io.writeFile.mockClear();
    for (let i = 0; i < 1_000; i++) store.recordSuccess(pair);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(io.writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saved().counts[0]!.count).toBe(1_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(io.writeFile).toHaveBeenCalledTimes(1);
    store.recordSuccess(pair);
    const close = store.close();
    expect(store.close()).toBe(close);
    await close;
    expect(saved()).toMatchObject({ cleanExit: true, counts: [{ count: 1_001 }] });
    expect(io.writeFile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves complete coverage after a clean close and same-day update", async () => {
    const { store, saved, restart } = memoryStore();
    await store.load();
    store.recordSuccess(pair);
    await store.close();
    expect(saved().cleanExit).toBe(true);
    const updated = restart("0.2.0");
    await updated.load();
    expect(saved().cleanExit).toBe(false);
    expect((await updated.query(query()))[0]).toMatchObject({ total: 1, coveredDays: 1 });
    expect((await updated.read()).days[0]!.appVersions).toEqual(["0.1.0", "0.2.0"]);
    expect((await updated.read()).coverage).toHaveLength(2);
  });
  it("can accumulate 30 covered days despite a clean restart every day", async () => {
    const memory = memoryStore();
    let store = memory.store;
    for (let offset = 0; offset < 30; offset++) {
      vi.setSystemTime(new Date(2026, 9, 7 + offset, 12));
      if (offset) store = memory.restart();
      await store.load(); store.recordSuccess(pair); await store.close();
    }
    const reopened = memory.restart();
    const result = (await reopened.query({ from: "2026-10-07", through: "2026-11-05", pairs: [pair] }))[0]!;
    expect(result).toMatchObject({ total: 30, usedDays: 30, coveredDays: 30 });
  });
  it("marks the last saved day and today incomplete after a crash across midnight", async () => {
    const initial = seed(); initial.cleanExit = false;
    initial.days[0]!.day = "2026-10-06";
    const { store } = memoryStore(initial);
    await store.load();
    expect((await store.read()).days.map(day => [day.day, day.complete]))
      .toEqual([["2026-10-06", false], ["2026-10-07", false]]);
  });
  it("marks only affected days incomplete when the clean marker is missing", async () => {
    const snapshot = seed();
    snapshot.days.unshift({ day: "2026-10-06", appVersions: ["0.1.0"], complete: true });
    const { cleanExit: _marker, ...unclean } = snapshot;
    const { store } = memoryStore(unclean);
    await store.load();
    expect((await store.read()).days).toEqual([
      { day: "2026-10-06", appVersions: ["0.1.0"], complete: true },
      { day: today(), appVersions: ["0.1.0"], complete: false },
    ]);
    expect((await store.query(query()))[0]!.total).toBeNull();
  });
  it("invalidates an idle clean marker before it admits queued successes", async () => {
    const { store, io, saved } = memoryStore();
    const entered = deferred(); const release = deferred();
    const rename = io.rename.getMockImplementation()!;
    io.rename.mockImplementationOnce(async (from, to) => { entered.resolve(); await release.promise; await rename(from, to); });
    const load = store.load();
    await entered.promise;
    store.recordSuccess(pair);
    expect(saved().cleanExit).toBe(true);
    release.resolve(); await load;
    expect(saved().cleanExit).toBe(false);
    expect((await store.read()).counts[0]!.count).toBe(1);
  });
  it("retains increments received while another snapshot is writing", async () => {
    const { store, io, saved } = memoryStore();
    await store.load(); store.recordSuccess(pair);
    const entered = deferred(); const release = deferred();
    const rename = io.rename.getMockImplementation()!;
    io.rename.mockImplementationOnce(async (from, to) => { entered.resolve(); await release.promise; await rename(from, to); });
    const flush = store.flush(); await entered.promise;
    store.recordSuccess(pair); release.resolve(); await flush;
    expect(saved().counts[0]!.count).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saved().counts[0]!.count).toBe(2);
  });
  it("keeps Off counts through restart, and Clear removes snapshots but keeps Off", async () => {
    const { store, restart, saved, disk, path } = memoryStore();
    await store.load(); store.recordSuccess(pair);
    const off = store.setEnabled(false);
    expect(store.recordSuccess(pair)).toBe(false);
    await off; await store.close();
    const next = restart(); await next.load();
    expect(next.recordSuccess(pair)).toBe(false);
    expect((await next.read()).counts[0]!.count).toBe(1);
    disk.set(path + ".tmp", "interrupted snapshot");
    await next.clear();
    expect(saved()).toMatchObject({ enabled: false, counts: [] });
    expect(disk.has(path + ".tmp")).toBe(false);
    await next.setEnabled(true); next.recordSuccess(pair);
    expect((await next.query(query()))[0]!.total).toBeNull();
  });
  it("orders Off and Clear behind a pending write without resurrecting cleared counts", async () => {
    const { store, io, saved, disk, path } = memoryStore();
    await store.load(); store.recordSuccess(pair);
    const entered = deferred(); const release = deferred();
    const rename = io.rename.getMockImplementation()!;
    io.rename.mockImplementationOnce(async (from, to) => { entered.resolve(); await release.promise; await rename(from, to); });
    const flush = store.flush(); await entered.promise;
    const off = store.setEnabled(false); const clear = store.clear();
    expect(store.recordSuccess(pair)).toBe(false);
    release.resolve(); await Promise.all([flush, off, clear]);
    expect(saved()).toMatchObject({ enabled: false, counts: [] });
    expect(disk.has(path + ".tmp")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saved().counts).toEqual([]);
  });
  it.each(["writeFile", "rename"] as const)("preserves the last complete snapshot on %s failure and retries", async method => {
    const { store, io, saved, onWriteFailure } = memoryStore();
    await store.load(); store.recordSuccess(pair); await store.flush();
    store.recordSuccess(pair); io[method].mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(store.flush()).rejects.toThrow("disk unavailable");
    expect(saved().counts[0]!.count).toBe(1);
    expect((await store.read()).counts[0]!.count).toBe(2);
    expect((await store.query(query()))[0]!.total).toBeNull();
    expect(onWriteFailure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saved().counts[0]!.count).toBe(2);
  });
  it.each(["clear", "off"] as const)("drops retired ids and permits %s while keeping known data where appropriate", async action => {
    const initial = { ...seed(), counts: [{ ...pair, day: today(), count: 3 },
      { capabilityId: "retired.action", door: "renderer", day: today(), count: 9 }],
      coverage: [{ appVersion: "0.1.0", pairs: [...mapping, { capabilityId: "retired.action", door: "renderer", status: "covered" }] }] };
    const { store, saved } = memoryStore(initial);
    if (action === "clear") await store.clear(); else await store.setEnabled(false);
    expect(saved().counts).toEqual(action === "clear" ? [] : [{ ...pair, day: today(), count: 3 }]);
    expect(saved().coverage[0]!.pairs).toEqual(mapping);
    expect(saved().enabled).toBe(action === "clear");
  });
  it.each(["EBUSY", "EPERM", "EACCES"])("leaves the record byte-identical while controls retry a persistent %s", async code => {
    const initial = seed(false);
    initial.counts.push({ ...pair, day: today(), count: 3 });
    const { store, io, disk, path, restart } = memoryStore(initial);
    const original = disk.get(path);
    disk.set(path + ".tmp", "interrupted snapshot");
    const readError = Object.assign(new Error("temporarily locked"), { code });
    const readFile = io.readFile.getMockImplementation()!;
    io.readFile.mockRejectedValue(readError);
    expect(store.recordSuccess(pair)).toBe(true);
    await store.load();
    expect(store.recordSuccess(pair)).toBe(false);
    await expect(store.read()).rejects.toBe(readError);
    await expect(store.query(query())).rejects.toBe(readError);
    await expect(store.setEnabled(false)).rejects.toBe(readError);
    await expect(store.setEnabled(true)).rejects.toBe(readError);
    await expect(store.clear()).rejects.toBe(readError);
    await expect(store.flush()).rejects.toBe(readError);
    await store.load();
    await vi.advanceTimersByTimeAsync(86_400_000);
    await store.close();
    expect(io.readFile).toHaveBeenCalledTimes(4);
    expect(io.writeFile).not.toHaveBeenCalled();
    expect(io.rename).not.toHaveBeenCalled();
    expect(io.rm).not.toHaveBeenCalled();
    expect(disk.get(path)).toBe(original);
    expect(disk.get(path + ".tmp")).toBe("interrupted snapshot");
    io.readFile.mockImplementation(readFile);
    const nextSession = restart();
    expect((await nextSession.read()).enabled).toBe(false);
    expect((await nextSession.read()).counts).toEqual(initial.counts);
  });
  it.each(["clear", "off", "on"] as const)("retries a failed load before %s once the lock clears", async action => {
    const initial = seed(action === "off");
    initial.counts.push({ ...pair, day: today(), count: 3 });
    const { store, io, disk, path, saved } = memoryStore(initial);
    disk.set(path + ".tmp", "interrupted snapshot");
    io.readFile.mockRejectedValueOnce(Object.assign(new Error("temporarily locked"), { code: "EBUSY" }));
    await store.load();
    expect(store.recordSuccess(pair)).toBe(false);
    if (action === "clear") await store.clear(); else await store.setEnabled(action === "on");
    expect(io.readFile).toHaveBeenCalledTimes(2);
    expect(saved().enabled).toBe(action === "on");
    expect(saved().counts).toEqual(action === "clear" ? [] : initial.counts);
    expect(disk.has(path + ".tmp")).toBe(false);
    expect(store.recordSuccess(pair)).toBe(action === "on");
  });
  it.each([
    ["bad JSON", '{"version":1,"enabled":true,"counts":['],
    ["schema mismatch", JSON.stringify({ version: 1, enabled: false, cleanExit: true, days: [], counts: "invalid", coverage: [] })],
    ["newer schema", JSON.stringify({ version: 2, enabled: false, cleanExit: true, days: [], counts: [], coverage: [] })],
  ])("preserves %s across launch, controls, midnight, close and restart", async (_reason, raw) => {
    const { store, io, disk, path, restart } = memoryStore();
    disk.set(path, raw);
    disk.set(path + ".tmp", "interrupted snapshot");
    expect(store.recordSuccess(pair)).toBe(true);
    await store.load();
    expect(disk.get(path)).toBe(raw);
    expect(store.recordSuccess(pair)).toBe(false);
    await expect(store.read()).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    await expect(store.query(query())).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    await expect(store.setEnabled(false)).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    await expect(store.setEnabled(true)).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    await expect(store.clear()).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    await expect(store.flush()).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    await vi.advanceTimersByTimeAsync(86_400_000 + USAGE_WRITE_INTERVAL_MS);
    await store.close();
    expect(disk.get(path)).toBe(raw);
    expect(disk.get(path + ".tmp")).toBe("interrupted snapshot");
    const next = restart();
    await next.load();
    expect(next.recordSuccess(pair)).toBe(false);
    await expect(next.read()).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    await next.close();
    expect(io.writeFile).not.toHaveBeenCalled();
    expect(io.rename).not.toHaveBeenCalled();
    expect(io.rm).not.toHaveBeenCalled();
    expect(disk.get(path)).toBe(raw);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("loads an externally repaired record on a control without restoring queued successes", async () => {
    const { store, disk, path, saved } = memoryStore();
    disk.set(path, "not JSON");
    store.recordSuccess(pair);
    await store.load();
    const repaired = seed(false);
    repaired.counts.push({ ...pair, day: today(), count: 3 });
    disk.set(path, JSON.stringify(repaired));
    await store.setEnabled(true);
    expect(saved()).toMatchObject({ enabled: true, counts: repaired.counts });
    expect((await store.read()).counts).toEqual(repaired.counts);
    expect(store.recordSuccess(pair)).toBe(true);
  });
  it("ignores interrupted temporary snapshots and can retry a failed Clear", async () => {
    const { store, io, saved, disk, path } = memoryStore();
    disk.set(path + ".tmp", "torn JSON");
    await store.load(); store.recordSuccess(pair); await store.flush();
    io.rename.mockRejectedValueOnce(new Error("failed Clear"));
    await expect(store.clear()).rejects.toThrow("failed Clear");
    expect(saved().counts).toHaveLength(1);
    await store.clear();
    expect(saved().counts).toEqual([]);
    expect(disk.has(path + ".tmp")).toBe(false);
  });
  it.each(["clear", "off", "on"] as const)("keeps memory and the file in agreement after a failed %s", async action => {
    const initial = seed(action !== "on");
    initial.counts.push({ ...pair, day: today(), count: 3 });
    const { store, io, saved } = memoryStore(initial);
    await store.load();
    io.rename.mockRejectedValueOnce(new Error("disk unavailable"));
    const control = action === "clear" ? store.clear() : store.setEnabled(action === "on");
    await expect(control).rejects.toThrow("disk unavailable");
    const read = await store.read();
    expect(read.enabled).toBe(action !== "on");
    expect(read.counts).toEqual(initial.counts);
    expect(saved()).toMatchObject({ enabled: action !== "on", counts: initial.counts });
    // The retried write keeps the old state, and nothing it lost comes back.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saved()).toMatchObject({ enabled: action !== "on", counts: initial.counts });
    expect(store.recordSuccess(pair)).toBe(action !== "on");
  });
  it("reuses fixed version coverage on each new complete day without per-day rows", async () => {
    const { store } = memoryStore(); await store.load();
    vi.setSystemTime(new Date(2026, 9, 8, 0, 1));
    store.recordSuccess(pair);
    expect((await store.query(query()))[0]).toMatchObject({ total: 1, coveredDays: 1 });
    expect((await store.read()).coverage).toHaveLength(1);
    expect((await store.read()).days).toHaveLength(2);
  });
  it("prunes old days at startup and local midnight while Off", async () => {
    vi.setSystemTime(new Date(2026, 9, 7, 23, 59, 59));
    const initial = seed(false);
    initial.days.unshift(...["2026-07-09", "2026-07-10"].map(day => ({ day, appVersions: ["0.1.0"], complete: false })));
    initial.counts = ["2026-07-09", "2026-07-10"].map(day => ({ ...pair, day, count: 1 }));
    const { store, saved } = memoryStore(initial); await store.load();
    expect((await store.read()).counts.map(row => row.day)).toEqual(["2026-07-10"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await store.read()).counts).toEqual([]);
    expect((await store.read()).days.at(-1)).toMatchObject({ day: today(), complete: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saved().counts).toEqual([]);
  });
  it("preserves real future days through a clock rollback, including more than 90 records", async () => {
    const initial = seed();
    for (let offset = 1; offset <= 90; offset++) {
      const date = new Date(); date.setDate(date.getDate() + offset);
      const day = localUsageDay(date);
      initial.days.push({ day, appVersions: ["0.1.0"], complete: true });
      initial.counts.push({ ...pair, day, count: 1 });
    }
    const { store, saved } = memoryStore(initial); await store.load();
    vi.setSystemTime(new Date(2026, 9, 6, 12)); store.recordSuccess(pair); await store.flush();
    expect(saved().counts).toHaveLength(91);
    expect(saved().days).toHaveLength(92);
  });
  it("queues successes before and during lazy loading without I/O on the recording path", async () => {
    const { store, io } = memoryStore();
    expect(store.recordSuccess(pair)).toBe(true);
    expect(io.readFile).not.toHaveBeenCalled();
    const read = deferred<string>(); io.readFile.mockImplementationOnce(() => read.promise);
    const load = store.load();
    expect(store.recordSuccess(pair)).toBe(true);
    read.resolve(JSON.stringify(seed())); await load;
    expect((await store.query(query()))[0]!.total).toBe(2);
  });
  it("bounds early successes, marks overflow incomplete, and respects persisted Off", async () => {
    const memory = memoryStore();
    for (let i = 0; i < USAGE_PENDING_LIMIT; i++) expect(memory.store.recordSuccess(pair)).toBe(true);
    expect(memory.store.recordSuccess(pair)).toBe(false);
    await memory.store.load();
    expect((await memory.store.read()).counts[0]!.count).toBe(USAGE_PENDING_LIMIT);
    expect((await memory.store.query(query()))[0]!.total).toBeNull();
    const off = memoryStore(seed(false)); off.store.recordSuccess(pair); await off.store.load();
    expect((await off.store.read()).counts).toEqual([]);
  });
  it("caps counts, leaves unused state alone on exit, and flushes queued state on exit", async () => {
    const initial = seed(); initial.counts.push({ ...pair, day: today(), count: 2_147_483_647 });
    const { store } = memoryStore(initial); await store.load();
    expect(store.recordSuccess(pair)).toBe(false);
    expect((await store.query(query()))[0]!.total).toBeNull();
    const unused = memoryStore(); await unused.store.close();
    expect(unused.io.readFile).not.toHaveBeenCalled();
    const queued = memoryStore(); queued.store.recordSuccess(pair); await queued.store.close();
    expect(queued.saved()).toMatchObject({ cleanExit: true, counts: [{ count: 1 }] });
  });
  it("writes, restarts and clears independently in real state directories", async () => {
    vi.useRealTimers();
    const firstDir = await createTestScratch("usage-first-");
    const secondDir = await createTestScratch("usage-second-");
    const make = (directory: string) => {
      const store = createUsageStore({ stateDir: () => directory, appVersion: "0.1.0" });
      stores.push(store); return store;
    };
    const first = make(firstDir); const second = make(secondDir);
    await Promise.all([first.load(), second.load()]); first.recordSuccess(pair);
    await Promise.all([first.close(), second.close()]);
    const restart = make(firstDir);
    expect((await restart.read()).counts[0]!.count).toBe(1);
    expect(JSON.parse(await fs.readFile(join(secondDir, USAGE_SNAPSHOT_NAME), "utf8")).counts).toEqual([]);
    await fs.writeFile(join(firstDir, USAGE_SNAPSHOT_NAME) + ".tmp", "interrupted");
    await restart.clear(); await restart.close();
    await expect(fs.stat(join(firstDir, USAGE_SNAPSHOT_NAME) + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
