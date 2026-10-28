import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localUsageDay, UsageSnapshot, type UsageBuildPair, type UsageSnapshot as Snapshot } from "@dohc/workspace-contracts/usage";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "../workspaces/testTemp";
import { createUsageStore, usageAsideName, USAGE_PENDING_LIMIT, USAGE_SNAPSHOT_NAME, USAGE_WRITE_INTERVAL_MS, type UsageFileSystem } from "./usageStore";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof fs>() }));

const pair = { capabilityId: "version.merge", door: "renderer" } as const;
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
  // The process stops at the first file operation `crash` matches, and does nothing after it.
  let crash: ((operation: string, path: string) => boolean) | undefined;
  let dead = false;
  const alive = (operation: string, path: string) => {
    if (dead || crash?.(operation, path)) { dead = true; throw new Error("dohc stopped"); }
  };
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  // Names whose contents were written but never synced. A power cut empties them.
  const unsynced = new Set<string>();
  const operations: string[] = [];
  const io = {
    readFile: vi.fn(async (path: string) => {
      alive("readFile", path);
      const text = disk.get(path);
      if (text === undefined) throw missing();
      return text;
    }),
    readdir: vi.fn(async (directory: string) => [...disk.keys()].filter(file => dirname(file) === directory).map(file => basename(file))),
    copyFile: vi.fn(async (from: string, to: string) => {
      alive("copyFile", from);
      if (!disk.has(from)) throw missing();
      disk.set(to, disk.get(from)!); unsynced.add(to);
    }),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, data: string) => { alive("writeFile", path); operations.push("write"); disk.set(path, data); unsynced.add(path); }),
    rename: vi.fn(async (from: string, to: string) => {
      operations.push("rename");
      alive("rename", from);
      if (!disk.has(from)) throw missing();
      disk.set(to, disk.get(from)!); disk.delete(from);
      if (unsynced.delete(from)) unsynced.add(to); else unsynced.delete(to);
    }),
    link: vi.fn(async (from: string, to: string) => {
      alive("link", from);
      if (!disk.has(from)) throw missing();
      if (disk.has(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      disk.set(to, disk.get(from)!);
      if (unsynced.has(from)) unsynced.add(to);
    }),
    unlink: vi.fn(async (path: string) => {
      alive("unlink", path);
      if (!disk.delete(path)) throw missing();
      unsynced.delete(path);
    }),
    rm: vi.fn(async (path: string) => { alive("rm", path); disk.delete(path); unsynced.delete(path); }),
    sync: vi.fn(async (path: string) => { alive("sync", path); operations.push("sync temp"); unsynced.delete(path); }),
    syncDirectory: vi.fn(async (directory: string) => { alive("syncDirectory", directory); operations.push("sync directory"); }),
  } satisfies UsageFileSystem;
  const stateDir = vi.fn(() => "isolated-state");
  const onWriteFailure = vi.fn();
  const onStop = vi.fn();
  const store = createUsageStore({ stateDir, appVersion: "0.1.0", coverage: buildMapping, io, onWriteFailure, onStop });
  stores.push(store);
  const restart = (appVersion = "0.1.0", coverage = buildMapping) => {
    if (dead) {
      // A stopped process never closes its store.
      stores.splice(stores.indexOf(store), 1);
      dead = false;
    }
    crash = undefined;
    const next = createUsageStore({ stateDir, appVersion, coverage, io });
    stores.push(next);
    return next;
  };
  const crashOn = (match: (operation: string, path: string) => boolean) => { crash = match; };
  // The power fails: the process stops, and what it never synced comes back empty.
  const powerCut = () => {
    dead = true;
    for (const file of unsynced) disk.set(file, "");
    unsynced.clear();
  };
  return { store, io, disk, path, stateDir, onWriteFailure, onStop, restart, crashOn, powerCut, operations,
    saved: () => UsageSnapshot.parse(JSON.parse(disk.get(path)!)) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12)); });
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); vi.useRealTimers(); });

describe("local usage store", () => {
  it("keeps the old record when file sync fails", async () => {
    const { store, io, disk, path, operations, onWriteFailure } = memoryStore();
    await store.load();
    const previous = disk.get(path);
    operations.length = 0;
    store.recordSuccess(pair);
    const failure = new Error("file sync failed");
    io.sync.mockRejectedValueOnce(failure);
    await expect(store.flush()).rejects.toBe(failure);
    expect(disk.get(path)).toBe(previous);
    expect(operations).toEqual(["write"]);
    expect(onWriteFailure).toHaveBeenCalledOnce();
    await store.flush();
    expect(JSON.parse(disk.get(path)!).counts[0].count).toBe(1);
  });
  it.each(["clear", "off", "on", "flush"] as const)("keeps the published %s state and retries after directory sync fails", async action => {
    const initial = seed(action !== "on");
    initial.counts.push({ ...pair, day: today(), count: 3 });
    const { store, io, saved, operations, onStop, onWriteFailure } = memoryStore(initial, mapping);
    await store.load();
    operations.length = 0;
    if (action === "flush") store.recordSuccess(pair);
    const failure = new Error("directory sync failed");
    io.syncDirectory.mockRejectedValueOnce(failure);
    const control = action === "clear" ? store.clear()
      : action === "flush" ? store.flush() : store.setEnabled(action === "on");
    await expect(control).rejects.toBe(failure);
    const expected = {
      enabled: action !== "off",
      counts: action === "clear" ? [] : [{ ...pair, day: today(), count: action === "flush" ? 4 : 3 }],
    };
    expect(operations).toEqual(["write", "sync temp", "rename"]);
    expect(saved()).toMatchObject(expected);
    expect(await store.read()).toMatchObject(expected);
    expect(onWriteFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(USAGE_WRITE_INTERVAL_MS);
    expect(saved()).toMatchObject(expected);
    expect(io.syncDirectory).toHaveBeenCalledTimes(3);
    expect(onStop).not.toHaveBeenCalled();
  });
  it.each(["linux", "darwin", "win32"] as const)("saves in durable order on %s", async platform => {
    vi.useRealTimers();
    const directory = await createTestScratch("usage-sync-order-");
    const path = join(directory, USAGE_SNAPSHOT_NAME);
    await fs.writeFile(path, JSON.stringify(seed()));
    const operations: string[] = [];
    const originalOpen = fs.open;
    const originalRename = fs.rename;
    const originalWrite = fs.writeFile;
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const kind = args[1] === "r+" ? "temp" : "directory";
      operations.push("open " + kind + (kind === "temp" ? " for sync" : ""));
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { operations.push("sync " + kind); if (kind === "temp" || descriptor.value !== "win32") await sync(); });
      vi.spyOn(handle, "close").mockImplementation(async () => { operations.push("close " + kind + (kind === "temp" ? " for sync" : "")); await close(); });
      return handle;
    });
    const write = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (file !== path + ".tmp") return originalWrite(file, data, options);
      // writeFile closes its handle; the existing sync helper reopens it.
      const handle = await originalOpen(file, "w", 0o600);
      operations.push("open temp");
      try { operations.push("write"); await handle.writeFile(data); }
      finally { operations.push("close temp"); await handle.close(); }
    });
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      operations.push("rename");
      await originalRename(...args);
    });
    const store = createUsageStore({ stateDir: () => directory, appVersion: "0.1.0", coverage: mapping });
    try {
      await store.load();
      operations.length = 0;
      store.recordSuccess(pair);
      await store.flush();
      expect(operations).toEqual([
        "open temp", "write", "close temp", "open temp for sync", "sync temp", "close temp for sync", "rename",
        ...(platform === "win32" ? [] : ["open directory", "sync directory", "close directory"]),
      ]);
      expect(write).toHaveBeenLastCalledWith(path + ".tmp", expect.any(String), { mode: 0o600 });
    } finally {
      try { await store.close(); }
      finally {
        open.mockRestore(); write.mockRestore(); rename.mockRestore();
        Object.defineProperty(process, "platform", descriptor);
      }
    }
  });
  it("keeps the old record readable after a power cut before rename", async () => {
    const initial = seed();
    initial.counts.push({ ...pair, day: today(), count: 7 });
    const { store, crashOn, powerCut, restart } = memoryStore(initial);
    await store.load();
    store.recordSuccess(pair);
    crashOn(operation => operation === "rename");
    await expect(store.flush()).rejects.toThrow("dohc stopped");
    powerCut();
    expect((await restart().read()).counts).toEqual(initial.counts);
  });
  it("loads an existing record and keeps its saved counts after a power cut", async () => {
    const initial = seed(false);
    initial.counts.push({ ...pair, day: today(), count: 7 });
    const { store, restart, powerCut } = memoryStore(initial);
    expect((await store.read()).counts).toEqual(initial.counts);
    await store.setEnabled(true);
    store.recordSuccess(pair);
    await store.flush();
    powerCut();
    const restored = await restart().read();
    expect(restored.enabled).toBe(true);
    expect(restored.counts).toEqual([{ ...pair, day: today(), count: 8 }]);
  });
  it("loads lazily once, defaults On, and leaves the uninstrumented build uncovered", async () => {
    const { store, io, stateDir } = memoryStore(null, []);
    expect(stateDir).not.toHaveBeenCalled();
    expect(io.readFile).not.toHaveBeenCalled();
    await Promise.all([store.load(), store.load()]);
    // A missing record, then the swap a first run never left to finish.
    expect(io.readFile).toHaveBeenCalledTimes(3);
    expect((await store.read()).enabled).toBe(true);
    const rows = await store.query({ ...query(), pairs: [pair, { capabilityId: "file.list", door: "mcp" },
      { capabilityId: "file.read", door: "mcp" }, { capabilityId: "file.search", door: "mcp" },
      { capabilityId: "workspace.list", door: "mcp" }, { capabilityId: "version.merge", door: "automation" }] });
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
  it.each(["clear", "off"] as const)("clears retired ids explicitly and permits %s while keeping known data where appropriate", async action => {
    const initial = { ...seed(), counts: [{ ...pair, day: today(), count: 3 },
      { capabilityId: "retired.action", door: "renderer", day: today(), count: 9 }],
      days: [{ day: today(), appVersions: ["0.2.0"], complete: true }],
      coverage: [{ appVersion: "0.2.0", pairs: [...mapping, { capabilityId: "retired.action", door: "renderer", status: "covered" }] }] };
    const { store, disk, path } = memoryStore(initial);
    if (action === "clear") await store.clear(); else await store.setEnabled(false);
    const persisted = JSON.parse(disk.get(path)!);
    expect(persisted.counts).toEqual(action === "clear" ? [] : [
      { ...pair, day: today(), count: 3 },
      { capabilityId: "retired.action", door: "renderer", day: today(), count: 9 },
    ]);
    expect(persisted.coverage).toEqual(action === "clear" ? [{ appVersion: "0.1.0", pairs: mapping }] : [
      { appVersion: "0.2.0", pairs: [...mapping, { capabilityId: "retired.action", door: "renderer", status: "covered" }] },
      { appVersion: "0.1.0", pairs: mapping },
    ]);
    expect(persisted.enabled).toBe(action === "clear");
  });
  it("preserves unknown ids and pairs through a non-destructive rewrite", async () => {
    const unknownCount = { capabilityId: "future.action", door: "renderer", day: today(), count: 9 };
    const unknownPair = { capabilityId: "future.action", door: "renderer", status: "covered" };
    const initial = { ...seed(), counts: [{ ...pair, day: today(), count: 3 }, unknownCount],
      days: [{ day: today(), appVersions: ["0.2.0"], complete: true }],
      coverage: [{ appVersion: "0.2.0", pairs: [...mapping, unknownPair] }] };
    const { store, disk, path } = memoryStore(initial);
    await store.load();
    await store.setEnabled(false);
    const persisted = JSON.parse(disk.get(path)!);
    expect(persisted.counts).toContainEqual(unknownCount);
    expect(persisted.coverage[0].pairs).toContainEqual(unknownPair);
  });
  it("replaces another build's coverage under the same version without absorbing unknown pairs", async () => {
    const unknownCount = { capabilityId: "future.action", door: "renderer", day: today(), count: 9 };
    const initial = { ...seed(), counts: [unknownCount],
      coverage: [{ appVersion: "0.1.0", pairs: [
        { ...pair, status: "uncovered" },
        { capabilityId: "future.action", door: "renderer", status: "covered" },
      ] }] };
    const { store, disk, path } = memoryStore(initial);
    await store.load();
    await store.setEnabled(false);
    const persisted = JSON.parse(disk.get(path)!);
    expect(persisted.counts).toEqual([unknownCount]);
    expect(persisted.coverage).toEqual([{ appVersion: "0.1.0", pairs: mapping }]);
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
    // The launch, then the read and three controls that each retry it.
    expect(io.readFile).toHaveBeenCalledTimes(5);
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
    // The launch, the retry, and the check before writing.
    expect(io.readFile).toHaveBeenCalledTimes(3);
    expect(saved().enabled).toBe(action === "on");
    expect(saved().counts).toEqual(action === "clear" ? [] : initial.counts);
    expect(disk.has(path + ".tmp")).toBe(false);
    expect(store.recordSuccess(pair)).toBe(action === "on");
  });
  it.each([
    ["bad JSON", '{"version":1,"enabled":true,"counts":['],
    ["schema mismatch", JSON.stringify({ version: 1, enabled: true, cleanExit: true, days: [], counts: "invalid", coverage: [] })],
    ["newer schema", JSON.stringify({ version: 2, enabled: true, cleanExit: true, days: [], counts: [], coverage: [] })],
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
    // A launch clears only a leftover swap beside the record.
    expect(io.rm.mock.calls.filter(([file]) => !file.startsWith(`${path}.incoming`))).toEqual([]);
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
  it("reads a record again once the person fixes what kept dohc from opening it", async () => {
    const { store, io } = memoryStore();
    const readError = Object.assign(new Error("denied"), { code: "EACCES" });
    io.readFile.mockRejectedValueOnce(readError).mockRejectedValueOnce(readError);
    await store.load();
    await expect(store.read()).rejects.toBe(readError);
    expect((await store.read()).enabled).toBe(true);
    expect(store.recordSuccess(pair)).toBe(true);
    expect(io.readFile).toHaveBeenCalledTimes(3);
  });
  it("refuses to set aside or restore over a record it cannot open", async () => {
    const { store, io, disk } = memoryStore();
    disk.set(join("isolated-state", usageAsideName(1)), "older");
    const readError = Object.assign(new Error("denied"), { code: "EACCES" });
    io.readFile.mockRejectedValue(readError);
    await store.load();
    await expect(store.startNewRecord()).rejects.toBe(readError);
    await expect(store.restoreSetAside()).rejects.toBe(readError);
    expect(io.rename).not.toHaveBeenCalled();
    expect(io.writeFile).not.toHaveBeenCalled();
  });
  it("sets an undecodable record aside and starts one that counts only after the person turns it on", async () => {
    const { store, disk, path, saved, restart } = memoryStore();
    disk.set(path, "not JSON");
    await store.load();
    expect(await store.newestAside()).toBeNull();
    await store.startNewRecord();
    expect(disk.get(join("isolated-state", usageAsideName(1)))).toBe("not JSON");
    expect(await store.newestAside()).toBe(usageAsideName(1));
    expect(saved()).toMatchObject({ enabled: false, counts: [] });
    expect(store.recordSuccess(pair)).toBe(false);
    await store.close();
    const next = restart();
    expect((await next.read()).enabled).toBe(false);
    await next.setEnabled(true);
    expect(next.recordSuccess(pair)).toBe(true);
    await next.flush();
    expect(saved()).toMatchObject({ enabled: true, counts: [{ count: 1 }] });
  });
  it("sets a record aside under the next unused number, never over another file", async () => {
    const { store, disk, path } = memoryStore();
    const at = (name: string) => join("isolated-state", name);
    disk.set(at(usageAsideName(1)), "first");
    disk.set(at(usageAsideName(3)), "third");
    disk.set(at("dohc-usage.set-aside-x.json"), "not one of ours");
    disk.set(path, "not JSON");
    await store.load();
    await store.startNewRecord();
    expect(disk.get(at(usageAsideName(1)))).toBe("first");
    expect(disk.get(at(usageAsideName(3)))).toBe("third");
    expect(disk.get(at("dohc-usage.set-aside-x.json"))).toBe("not one of ours");
    expect(disk.get(at(usageAsideName(4)))).toBe("not JSON");
    expect(await store.newestAside()).toBe(usageAsideName(4));
  });
  it("restores by swapping the files, keeps the newer record's last counts, and swaps back", async () => {
    const { store, disk, path, saved } = memoryStore();
    const at = (number: number) => join("isolated-state", usageAsideName(number));
    disk.set(path, "not JSON");
    await store.load();
    await store.startNewRecord();
    await store.setEnabled(true);
    expect(store.recordSuccess(pair)).toBe(true);
    await store.restoreSetAside();
    expect(disk.get(path)).toBe("not JSON");
    expect(disk.has(at(1))).toBe(false);
    expect(JSON.parse(disk.get(at(2))!)).toMatchObject({ enabled: true, counts: [{ count: 1 }] });
    await expect(store.read()).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    expect(await store.newestAside()).toBe(usageAsideName(2));
    expect(store.recordSuccess(pair)).toBe(false);
    await store.restoreSetAside();
    expect(disk.get(at(3))).toBe("not JSON");
    expect(saved()).toMatchObject({ enabled: true, counts: [{ count: 1 }] });
    expect((await store.read()).counts).toEqual([{ ...pair, day: today(), count: 1 }]);
    expect(store.recordSuccess(pair)).toBe(true);
  });
  // Fails the next move of `from`, and only that one.
  function failMove(io: ReturnType<typeof memoryStore>["io"], from: string, error = new Error("file in use")) {
    const link = io.link.getMockImplementation()!;
    io.link.mockImplementation(async (source, target) => {
      if (source !== from) return link(source, target);
      io.link.mockImplementation(link);
      throw error;
    });
  }
  it("leaves every file under its name when a move fails, and reports it", async () => {
    const { store, io, disk, path } = memoryStore();
    const at = (number: number) => join("isolated-state", usageAsideName(number));
    disk.set(path, "not JSON");
    await store.load();
    failMove(io, path);
    await expect(store.startNewRecord()).rejects.toThrow("file in use");
    expect(disk.get(path)).toBe("not JSON");
    expect(disk.has(at(1))).toBe(false);
    expect([...disk.keys()].filter(file => file.includes(".incoming"))).toEqual([]);
    await expect(store.read()).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });

    await store.startNewRecord();
    const newer = disk.get(path);
    // The newer record moves aside, the older one cannot move in, so the newer returns.
    failMove(io, `${path}.incoming`);
    await expect(store.restoreSetAside()).rejects.toThrow("file in use");
    expect(disk.get(path)).toBe(newer);
    expect(disk.get(at(1))).toBe("not JSON");
    expect(disk.has(at(2))).toBe(false);
    // A rolled-back Restore leaves nothing a later launch could install.
    expect([...disk.keys()].filter(file => file.includes(".incoming"))).toEqual([]);
    expect((await store.read()).enabled).toBe(false);
  });
  // An older record set aside with 7 counts, ready to restore over the active one.
  function withOlderAside() {
    const memory = memoryStore();
    memory.disk.set(join("isolated-state", usageAsideName(1)),
      JSON.stringify({ ...seed(false), counts: [{ ...pair, day: today(), count: 7 }] }));
    return memory;
  }
  it.each([
    ["the move is refused", "refused"],
    ["the record moves aside but cannot leave its name", "unlink"],
  ] as const)("leaves nothing a later launch installs when %s", async (_case, failure) => {
    const { store, io, disk, path, restart } = withOlderAside();
    await store.load();
    if (failure === "refused") failMove(io, path);
    else io.unlink.mockImplementationOnce(async () => { throw new Error("file in use"); });
    await expect(store.restoreSetAside()).rejects.toThrow("file in use");
    expect([...disk.keys()].filter(file => file.includes(".incoming"))).toEqual([]);
    expect(disk.has(join("isolated-state", usageAsideName(2)))).toBe(false);
    await store.close();
    // The person quits and deletes the record: the next launch starts fresh.
    disk.delete(path);
    expect((await restart().read()).counts).toEqual([]);
  });
  it("installs nothing when dohc stopped before moving the record and the person then deleted it", async () => {
    const { store, disk, path, restart, crashOn } = withOlderAside();
    await store.load();
    crashOn((operation, file) => operation === "link" && file === path);
    await expect(store.restoreSetAside()).rejects.toThrow("dohc stopped");
    disk.delete(path);
    const next = restart();
    expect((await next.read()).counts).toEqual([]);
    expect([...disk.keys()].filter(file => file.includes(".incoming"))).toEqual([]);
  });
  it("reports a Start whose new record could not be written, and moves nothing", async () => {
    const { store, io, disk, path } = memoryStore();
    disk.set(path, "not JSON");
    await store.load();
    io.writeFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.startNewRecord()).rejects.toThrow("disk full");
    expect(disk.get(path)).toBe("not JSON");
    expect(await store.newestAside()).toBeNull();
    await expect(store.read()).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    expect(store.recordSuccess(pair)).toBe(false);
  });
  const steps = Array.from({ length: 22 }, (_, index) => index + 1);
  it.each(steps)("never turns recording on after dohc stops at file change %i of a Start", async step => {
    const { store, disk, path, restart, crashOn } = memoryStore();
    disk.set(path, "not JSON");
    await store.load();
    let changes = 0;
    crashOn(operation => operation !== "readFile" && ++changes === step);
    // A Start that finished shuts down as usual; one that stopped never closes.
    if (await store.startNewRecord().then(() => true, () => false)) await store.close().catch(() => {});
    const next = restart();
    const read = await next.read().catch((error: { code?: string }) => error.code);
    expect(read === "INVALID_USAGE_RECORD" || typeof read === "object" && !read.enabled).toBe(true);
    expect(next.recordSuccess(pair)).toBe(false);
    expect([...disk.values()]).toContain("not JSON");
  });
  it.each(steps)("keeps both records after dohc stops at file change %i of a Restore", async step => {
    const older = seed(false);
    older.counts.push({ ...pair, day: today(), count: 7 });
    const { store, disk, path, restart, crashOn } = memoryStore();
    disk.set(join("isolated-state", usageAsideName(1)), JSON.stringify(older));
    await store.load();
    for (let i = 0; i < 3; i++) store.recordSuccess(pair);
    await store.flush();
    let changes = 0;
    crashOn(operation => operation !== "readFile" && ++changes === step);
    if (await store.restoreSetAside().then(() => true, () => false)) await store.close().catch(() => {});
    const next = restart();
    const active = (await next.read()).counts.map(row => row.count);
    expect([[3], [7]]).toContainEqual(active);
    const kept = [...disk.entries()].filter(([file]) => !file.endsWith(".tmp")).flatMap(([, text]) => {
      try { return [UsageSnapshot.parse(JSON.parse(text)).counts.map(row => row.count).join()]; } catch { return []; }
    });
    expect(kept).toEqual(expect.arrayContaining(["3", "7"]));
  });
  it("reads the file again when Privacy reads, and never writes over a replaced file", async () => {
    const { store, disk, path } = memoryStore();
    await store.load();
    expect((await store.read()).enabled).toBe(true);
    disk.set(path, "not JSON");
    await expect(store.read()).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    const replacement = JSON.stringify(seed(false));
    disk.set(path, replacement);
    expect((await store.read()).enabled).toBe(false);
    await store.setEnabled(true);
    expect(store.recordSuccess(pair)).toBe(true);
    disk.set(path, replacement);
    await vi.advanceTimersByTimeAsync(USAGE_WRITE_INTERVAL_MS);
    expect(disk.get(path)).toBe(replacement);
    expect(store.recordSuccess(pair)).toBe(false);
    expect((await store.read()).enabled).toBe(false);
  });
  it("skips set-aside numbers it cannot add one to, and overwrites none", async () => {
    const { store, disk, path } = memoryStore();
    const at = (name: string) => join("isolated-state", name);
    disk.set(at("dohc-usage.set-aside-9007199254740991.json"), "largest safe");
    disk.set(at("dohc-usage.set-aside-9007199254740992.json"), "unsafe");
    disk.set(at("dohc-usage.set-aside-01.json"), "leading zero");
    disk.set(path, "not JSON");
    await store.load();
    await store.startNewRecord();
    expect(disk.get(at("dohc-usage.set-aside-9007199254740991.json"))).toBe("largest safe");
    expect(disk.get(at("dohc-usage.set-aside-9007199254740992.json"))).toBe("unsafe");
    expect(disk.get(at("dohc-usage.set-aside-01.json"))).toBe("leading zero");
    expect(disk.get(at(usageAsideName(1)))).toBe("not JSON");
  });
  it("stops counting and reports both failures when Restore can put neither record in place", async () => {
    const older = seed(false);
    older.counts.push({ ...pair, day: today(), count: 7 });
    const { store, io, disk, path } = memoryStore();
    disk.set(join("isolated-state", usageAsideName(1)), JSON.stringify(older));
    await store.load();
    const aside = join("isolated-state", usageAsideName(2));
    const link = io.link.getMockImplementation()!;
    io.link.mockImplementation(async (source, target) => {
      if (source === `${path}.incoming` || source === aside) throw new Error("file in use");
      return link(source, target);
    });
    await expect(store.restoreSetAside()).rejects.toThrow("could not put either usage record back in place");
    expect(disk.has(path)).toBe(false);
    expect(store.recordSuccess(pair)).toBe(false);
    io.link.mockImplementation(link);
    // The next read finishes the swap from the record waiting beside it.
    expect((await store.read()).counts.map(row => row.count)).toEqual([7]);
  });
  it.each(["one dohc can read", "one dohc cannot decode"])("syncs a restored record, %s, before it moves, so a power cut keeps it", async kind => {
    const older = kind === "one dohc can read" ? JSON.stringify({ ...seed(false), counts: [{ ...pair, day: today(), count: 7 }] }) : "not JSON";
    const { store, io, disk, path, restart, powerCut } = memoryStore();
    disk.set(join("isolated-state", usageAsideName(1)), older);
    await store.load();
    await store.restoreSetAside();
    const incoming = io.sync.mock.calls.findIndex(([file]) => file === `${path}.incoming`);
    expect(incoming).toBeGreaterThanOrEqual(0);
    expect(io.sync.mock.invocationCallOrder[incoming]).toBeLessThan(Math.min(...io.link.mock.invocationCallOrder));
    powerCut();
    const next = restart();
    if (older === "not JSON") expect(disk.get(path)).toBe("not JSON");
    else expect((await next.read()).counts.map(row => row.count)).toEqual([7]);
  });
  it("keeps a file another program puts at the record's name during a Restore", async () => {
    const { store, io, disk, path } = memoryStore();
    const older = join("isolated-state", usageAsideName(1));
    disk.set(older, "older");
    await store.load();
    await store.flush();
    const active = disk.get(path);
    // The file appears after the active record moves aside, before the restored one moves in.
    const appear = (from: string) => { if (from === `${path}.incoming`) disk.set(path, "someone else's"); };
    const link = io.link.getMockImplementation()!;
    io.link.mockImplementation(async (from, to) => { appear(from); return link(from, to); });
    const rename = io.rename.getMockImplementation()!;
    io.rename.mockImplementation(async (from, to) => { appear(from); return rename(from, to); });
    await expect(store.restoreSetAside()).rejects.toThrow();
    expect(disk.get(path)).toBe("someone else's");
    expect(disk.get(join("isolated-state", usageAsideName(2)))).toBe(active);
    expect(disk.get(older)).toBe("older");
    expect(store.recordSuccess(pair)).toBe(false);
  });
  it("discards a leftover incoming record when the record is in place, and when a person deleted it", async () => {
    const older = JSON.stringify({ ...seed(), counts: [{ ...pair, day: "2026-10-07", count: 7 }] });
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const present = memoryStore();
    present.disk.set(`${present.path}.incoming`, older);
    present.disk.set(`${present.path}.incoming.ready`, sha(older));
    await present.store.load();
    expect([...present.disk.keys()].filter(file => file.includes(".incoming"))).toEqual([]);

    // Never committed, or committed to other bytes: a person who deleted the record starts fresh.
    for (const ready of [undefined, sha("other bytes")]) {
      const deleted = memoryStore(null);
      deleted.disk.set(`${deleted.path}.incoming`, older);
      if (ready) deleted.disk.set(`${deleted.path}.incoming.ready`, ready);
      expect((await deleted.store.read()).counts).toEqual([]);
      expect([...deleted.disk.keys()].filter(file => file.includes(".incoming"))).toEqual([]);
    }
  });
  it("tells main when a timed save stops counting, and leaves a control to report its own", async () => {
    const { store, io, disk, path, onStop } = memoryStore();
    await store.load();
    store.recordSuccess(pair);
    disk.set(path, JSON.stringify(seed(false)));
    await vi.advanceTimersByTimeAsync(USAGE_WRITE_INTERVAL_MS);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(store.recordSuccess(pair)).toBe(false);
    await store.read();
    // The file changes inside Clear, after its read. Clear reports that itself.
    io.rm.mockImplementationOnce(async () => { disk.set(path, `${JSON.stringify(seed(false))} `); });
    await expect(store.clear()).rejects.toThrow("changed outside dohc");
    expect(onStop).toHaveBeenCalledTimes(1);
  });
  it("keeps unsaved counts through a read that fails for a moment, such as during a scan", async () => {
    const { store, io } = memoryStore();
    await store.load();
    store.recordSuccess(pair);
    store.recordSuccess(pair);
    io.readFile.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EBUSY" }));
    await expect(store.read()).rejects.toMatchObject({ code: "EBUSY" });
    expect((await store.read()).counts).toEqual([{ ...pair, day: today(), count: 2 }]);
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
