import * as disk from "node:fs/promises";
import { join } from "node:path";
import * as timers from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationRunStore, type StoredRun } from "./automationRunStore";
import { createTestScratch, testMetadataDir } from "./testScratch";

const io = vi.hoisted(() => ({
  rename: vi.fn<typeof disk.rename>(), delay: vi.fn<typeof timers.setTimeout>(),
  readFile: vi.fn<typeof disk.readFile>(), open: vi.fn<typeof disk.open>(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof disk>(), rename: io.rename, readFile: io.readFile, open: io.open,
}));
vi.mock("node:timers/promises", async (original) => ({
  ...await original<typeof timers>(), setTimeout: io.delay,
}));
const actual = await vi.importActual<typeof disk>("node:fs/promises");
const clock = await vi.importActual<typeof timers>("node:timers/promises");

beforeEach(() => {
  io.rename.mockImplementation(actual.rename);
  io.delay.mockImplementation(clock.setTimeout);
  io.readFile.mockImplementation(actual.readFile);
  io.open.mockImplementation(actual.open);
});
afterEach(() => {
  vi.resetAllMocks();
});

async function savedRun() {
  const root = await createTestScratch("dohc-run-store-windows-");
  const store = createAutomationRunStore(root, testMetadataDir);
  const run: StoredRun = {
    version: 9, claimId: "reader", automationId: "collection:Tasks#bump",
    definitionHash: "0123456789abcdef", keySeed: "0123456789abcdef",
    startedAtMs: 1, finishedAtMs: 1, steps: [], applied: [], created: [], replans: [],
    undoRequests: [], undoCalls: [], undoCovers: [], readableFields: null,
    collections: [], rules: null, superseded: false, undo: null, undoKept: [],
    settled: false, outcome: { state: "done" },
  };
  await store.save(run);
  const runs = join(root, ".dohc", "automations", "runs");
  const folder = join(runs, (await actual.readdir(runs))[0]!);
  const path = join(folder, (await actual.readdir(folder)).find(name => name.endsWith(".json"))!);
  io.rename.mockClear();
  const progressPath = join(folder, (await actual.readdir(folder)).find(name => name.endsWith(".progress.jsonl"))!);
  return { root, store, run, folder, path, progressPath };
}

describe.skipIf(process.platform !== "win32")("Windows run-store replacement", () => {
  it.each(["save", "updateState"])("queues %s replacement behind an in-process history read", async (operation) => {
    const { root, store, run, path, progressPath } = await savedRun();
    const destination = operation === "save" ? progressPath : path;
    const reading = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const staged = Promise.withResolvers<void>();
    const releaseStage = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let held = false;
    let holdRead = operation === "save";
    io.readFile.mockImplementation((async (file, options) => {
      if (file !== destination || held || !holdRead) return actual.readFile(file, options);
      held = true;
      const reader = await actual.open(destination, "r");
      try {
        reading.resolve();
        await releaseRead.promise;
        return await reader.readFile(options);
      } finally {
        await reader.close();
      }
    }) as typeof disk.readFile);
    io.open.mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode);
      if (String(file).startsWith(`${destination}.tmp-`)) {
        const sync = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        handle.sync = async () => {
          await sync();
          staged.resolve();
          await releaseStage.promise;
        };
        handle.close = async () => {
          await close();
          closed.resolve();
        };
      }
      return handle;
    });
    const readerStore = createAutomationRunStore(root, testMetadataDir);
    let history: Promise<unknown> | undefined;
    let write: Promise<void> | undefined;
    try {
      if (operation === "save") {
        history = readerStore.runsOf(run.automationId, run.claimId);
        await reading.promise;
        write = store.save({ ...run, settled: true });
      } else {
        write = store.updateState(run, { settled: true });
        await staged.promise;
        holdRead = true;
        history = readerStore.runsOf(run.automationId, run.claimId);
        await reading.promise;
      }
      const settledWrite = write.catch(error => error);
      await staged.promise;
      releaseStage.resolve();
      await closed.promise;
      // Run after the close's microtasks have queued the replacement.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(io.rename).not.toHaveBeenCalled();
      releaseRead.resolve();
      await expect(settledWrite).resolves.toBeUndefined();
      await history;
      expect(io.rename.mock.calls.filter(([, to]) => to === destination)).toHaveLength(1);
      expect(io.rename).toHaveBeenCalledTimes(operation === "save" ? 2 : 1);
      expect(io.delay).not.toHaveBeenCalled();
    } finally {
      releaseStage.resolve();
      releaseRead.resolve();
      await Promise.allSettled([write, history]);
    }
  });

  it.each(["state", "progress"])("saves %s after an open snapshot reader releases the destination", async (part) => {
    const { store, run, path, progressPath, folder } = await savedRun();
    const destination = part === "state" ? path : progressPath;
    const saved = await actual.readFile(destination, "utf8");
    const reader = await actual.open(destination, "r");
    const before = await reader.readFile("utf8");
    const conflicts: string[] = [];
    io.rename.mockImplementation(async (from, to) => {
      try {
        await actual.rename(from, to);
      } catch (error) {
        conflicts.push((error as NodeJS.ErrnoException).code!);
        await reader.close();
        throw error;
      }
    });
    try {
      const write = part === "state" ? store.updateState(run, { settled: true }) : store.save({ ...run, settled: true });
      await expect(write).resolves.toBeUndefined();
      expect(conflicts).toEqual(["EPERM"]);
      expect(before).toBe(saved);
      expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [{ ...run, settled: true }], unreadable: false });
      expect((await actual.readdir(folder)).some(name => name.includes(".tmp-"))).toBe(false);
    } finally {
      await reader.close();
    }
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("retries an append open after %s", async (code) => {
    const { store, run, progressPath } = await savedRun();
    const error = Object.assign(new Error("reader refuses writes"), { code });
    let attempts = 0;
    io.open.mockImplementation(async (path, flags, mode) => {
      if (path === progressPath && flags === "a" && attempts++ === 0) throw error;
      return actual.open(path, flags, mode);
    });
    io.delay.mockResolvedValue(undefined);
    const step = { ordinal: 0, effects: [] };
    await store.appendStep(run, step);
    expect(attempts).toBe(2);
    expect(io.delay).toHaveBeenCalledTimes(1);
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [{ ...run, steps: [step] }], unreadable: false });
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("bounds a persistent append open %s without changing progress", async (code) => {
    const { store, run, progressPath } = await savedRun();
    const before = await actual.readFile(progressPath, "utf8");
    const error = Object.assign(new Error("reader still refuses writes"), { code });
    io.open.mockImplementation(async (path, flags, mode) => {
      if (path === progressPath && flags === "a") throw error;
      return actual.open(path, flags, mode);
    });
    io.delay.mockResolvedValue(undefined);
    await expect(store.appendStep(run, { ordinal: 0, effects: [] })).rejects.toBe(error);
    expect(io.open.mock.calls.filter(([path, flags]) => path === progressPath && flags === "a")).toHaveLength(100);
    expect(io.delay).toHaveBeenCalledTimes(99);
    expect(io.delay.mock.calls.reduce((total, [ms]) => total + ms!, 0)).toBe(2381);
    expect(await actual.readFile(progressPath, "utf8")).toBe(before);
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [run], unreadable: false });
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("bounds persistent %s and retains the saved record", async (code) => {
    const { root, store, run, folder, path } = await savedRun();
    const before = await actual.readFile(path, "utf8");
    const error = Object.assign(new Error("destination is still open"), { code });
    io.rename.mockRejectedValue(error);
    io.delay.mockResolvedValue(undefined);
    await expect(store.updateState(run, { settled: true })).rejects.toBe(error);
    expect(io.rename).toHaveBeenCalledTimes(100);
    expect(io.delay).toHaveBeenCalledTimes(99);
    expect(io.delay.mock.calls.reduce((total, [ms]) => total + ms!, 0)).toBe(2381);
    expect(await actual.readFile(path, "utf8")).toBe(before);
    expect((await actual.readdir(folder)).some(name => name.includes(".tmp-"))).toBe(false);
    io.rename.mockImplementation(actual.rename);
    const restarted = createAutomationRunStore(root, testMetadataDir);
    expect(await restarted.runsOf(run.automationId, run.claimId)).toEqual({ runs: [run], unreadable: false });
    await store.updateState(run, { settled: true });
    expect((await restarted.runsOf(run.automationId, run.claimId)).runs[0]?.settled).toBe(true);
  });

  it("surfaces a non-contention error without retrying", async () => {
    const { store, run } = await savedRun();
    const error = Object.assign(new Error("disk error"), { code: "EIO" });
    io.rename.mockRejectedValue(error);
    await expect(store.updateState(run, { settled: true })).rejects.toBe(error);
    expect(io.rename).toHaveBeenCalledTimes(1);
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [run], unreadable: false });
  });
});
