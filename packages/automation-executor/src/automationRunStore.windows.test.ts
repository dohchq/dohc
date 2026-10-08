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
  vi.unstubAllGlobals();
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
    const { root, store, run, path } = await savedRun();
    const destination = path;
    const reading = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const staged = Promise.withResolvers<void>();
    const releaseStage = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let held = false;
    let holdRead = false;
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
      write = operation === "save" ? store.save({ ...run, settled: true }) : store.updateState(run, { settled: true });
      await staged.promise;
      holdRead = true;
      history = readerStore.runsOf(run.automationId, run.claimId);
      await reading.promise;
      const settledWrite = write.catch(error => error);
      await staged.promise;
      releaseStage.resolve();
      await closed.promise;
      // Run after the close's microtasks have queued the replacement.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(io.rename.mock.calls.filter(([, to]) => to === destination)).toHaveLength(0);
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

  it.each(["state", "save"])("saves %s after an open snapshot reader releases the destination", async (part) => {
    const { store, run, path, folder } = await savedRun();
    const destination = path;
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

describe("whole run saves", () => {
  it("exposes only the previous pair while the new header is waiting to commit", async () => {
    const { root, store, run, path } = await savedRun();
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    io.open.mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode);
      if (String(file).startsWith(`${path}.tmp-`)) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          staged.resolve();
          await release.promise;
        };
      }
      return handle;
    });
    const next = { ...run, settled: true, steps: [{ ordinal: 0, effects: [] }] };
    const write = store.save(next);
    try {
      await staged.promise;
      const reader = createAutomationRunStore(root, testMetadataDir);
      expect(await reader.runsOf(run.automationId, run.claimId)).toEqual({ runs: [run], unreadable: false });
    } finally {
      release.resolve();
      await write;
    }
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [next], unreadable: false });
  });

  it("keeps an old header's progress available when a save commits during its read", async () => {
    const { root, store, run, progressPath } = await savedRun();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    io.readFile.mockImplementation((async (file, options) => {
      if (file === progressPath) {
        reading.resolve();
        await release.promise;
      }
      return actual.readFile(file, options);
    }) as typeof disk.readFile);
    const reader = createAutomationRunStore(root, testMetadataDir);
    const history = reader.runsOf(run.automationId, run.claimId);
    const next = { ...run, settled: true, steps: [{ ordinal: 0, effects: [] }] };
    try {
      await reading.promise;
      await store.save(next);
    } finally {
      release.resolve();
    }
    expect(await history).toEqual({ runs: [run], unreadable: false });
    expect(await reader.runsOf(run.automationId, run.claimId)).toEqual({ runs: [next], unreadable: false });
  });

  it("keeps published progress when the header's directory sync fails", async () => {
    const { root, store, run, folder } = await savedRun();
    const error = Object.assign(new Error("directory sync failed"), { code: "EIO" });
    // Exercise POSIX's post-rename durability step on either host.
    vi.stubGlobal("process", { ...process, platform: "linux" });
    let syncs = 0;
    io.open.mockImplementation(async (file, flags, mode) => {
      if (file === folder && flags === "r") return {
        sync: async () => { if (++syncs === 2) throw error; },
        close: async () => undefined,
      } as Awaited<ReturnType<typeof disk.open>>;
      return actual.open(file, flags, mode);
    });
    const next = { ...run, settled: true, steps: [{ ordinal: 0, effects: [] }] };
    await expect(store.save(next)).rejects.toBe(error);
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [next], unreadable: false });
    const reopened = createAutomationRunStore(root, testMetadataDir);
    expect(await reopened.runsOf(run.automationId, run.claimId)).toEqual({ runs: [next], unreadable: false });
  });

  it("keeps the previous complete run when the second replacement fails, including after reopening", async () => {
    const { root, store, run, path, folder } = await savedRun();
    const before = await actual.readFile(path, "utf8");
    const files = await actual.readdir(folder);
    const error = Object.assign(new Error("header replacement failed"), { code: "EIO" });
    io.rename.mockImplementation(async (from, to) => {
      if (to === path) throw error;
      return actual.rename(from, to);
    });
    const next = { ...run, settled: true, steps: [{ ordinal: 0, effects: [] }] };
    await expect(store.save(next)).rejects.toBe(error);
    expect(io.rename).toHaveBeenCalledTimes(2);
    expect(await actual.readFile(path, "utf8")).toBe(before);
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [run], unreadable: false });
    const reopened = createAutomationRunStore(root, testMetadataDir);
    expect(await reopened.runsOf(run.automationId, run.claimId)).toEqual({ runs: [run], unreadable: false });
    expect(await actual.readdir(folder)).toEqual(files);
    const step = { ordinal: 0, effects: [] };
    await reopened.appendStep(run, step);
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [{ ...run, steps: [step] }], unreadable: false });
  });

  it("reads, updates, appends, and saves the existing fixed-name layout without a migration", async () => {
    const { root, store, run, path, progressPath } = await savedRun();
    const header = JSON.parse(await actual.readFile(path, "utf8"));
    delete header.progressId;
    const fixedProgress = path.slice(0, -".json".length) + ".progress.jsonl";
    await actual.rename(progressPath, fixedProgress);
    await actual.writeFile(path, JSON.stringify(header) + "\n");
    const reopened = createAutomationRunStore(root, testMetadataDir);
    expect(await reopened.runsOf(run.automationId, run.claimId)).toEqual({ runs: [run], unreadable: false });
    await reopened.updateState(run, { settled: true });
    const step = { ordinal: 0, effects: [] };
    await reopened.appendStep(run, step);
    const saved = { ...run, settled: true, steps: [step] };
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [saved], unreadable: false });
    const error = Object.assign(new Error("header replacement failed"), { code: "EIO" });
    io.rename.mockImplementation(async (from, to) => {
      if (to === path) throw error;
      return actual.rename(from, to);
    });
    await expect(reopened.save({ ...saved, settled: false, steps: [] })).rejects.toBe(error);
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [saved], unreadable: false });
    io.rename.mockImplementation(actual.rename);
    await reopened.save(saved);
    const currentHeader = JSON.parse(await actual.readFile(path, "utf8"));
    expect(currentHeader.progressId).toEqual(expect.any(String));
    await store.appendStep(run, { ordinal: 1, effects: [] });
    expect(await actual.readFile(fixedProgress, "utf8")).toBe(JSON.stringify({ kind: "step", ...step }) + "\n");
    expect((await reopened.runsOf(run.automationId, run.claimId)).runs[0]?.steps).toEqual([step, { ordinal: 1, effects: [] }]);
    await store.updateState(run, { settled: false });
    expect(JSON.parse(await actual.readFile(path, "utf8")).progressId).toBe(currentHeader.progressId);
  });

  it("retains the selected generation when expiry ends a run and removes every generation on expiry", async () => {
    const { store, run, path, folder } = await savedRun();
    await store.save({ ...run, finishedAtMs: null, outcome: null });
    const progressId = JSON.parse(await actual.readFile(path, "utf8")).progressId;
    expect((await actual.readdir(folder)).filter(name => name.endsWith(".progress.jsonl"))).toHaveLength(2);
    const ended = 1000;
    await store.expire(ended, async () => "settled", null);
    expect(JSON.parse(await actual.readFile(path, "utf8")).progressId).toBe(progressId);
    expect((await store.runsOf(run.automationId, run.claimId)).runs[0]?.finishedAtMs).toBe(ended);
    await store.expire(ended + 30 * 24 * 60 * 60 * 1000, async () => "gone", null);
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [], unreadable: false });
    await expect(actual.readdir(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
