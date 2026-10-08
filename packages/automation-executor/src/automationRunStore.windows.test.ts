import * as disk from "node:fs/promises";
import { join } from "node:path";
import * as timers from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationRunStore, type StoredRun } from "./automationRunStore";
import { createTestScratch, testMetadataDir } from "./testScratch";

const io = vi.hoisted(() => ({
  readFile: vi.fn<typeof disk.readFile>(), rename: vi.fn<typeof disk.rename>(), delay: vi.fn<typeof timers.setTimeout>(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof disk>(), readFile: io.readFile, rename: io.rename,
}));
vi.mock("node:timers/promises", async (original) => ({
  ...await original<typeof timers>(), setTimeout: io.delay,
}));
const actual = await vi.importActual<typeof disk>("node:fs/promises");
const clock = await vi.importActual<typeof timers>("node:timers/promises");

beforeEach(() => {
  io.readFile.mockImplementation(actual.readFile);
  io.rename.mockImplementation(actual.rename);
  io.delay.mockImplementation(clock.setTimeout);
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
  it.each(["state", "progress"])("saves %s after an overlapping history reader releases the destination", async (part) => {
    const { store, run, path, progressPath, folder } = await savedRun();
    const destination = part === "state" ? path : progressPath;
    const opened = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let captured = false;
    io.readFile.mockImplementation(async (...args) => {
      if (String(args[0]) !== destination || captured) return actual.readFile(...args);
      captured = true;
      const file = await actual.open(destination, "r");
      opened.resolve();
      try {
        await release.promise;
        return await file.readFile(args[1]);
      } finally {
        await file.close();
      }
    });
    const reader = store.runsOf(run.automationId, run.claimId);
    await opened.promise;
    const conflicts: string[] = [];
    io.rename.mockImplementation(async (from, to) => {
      try {
        await actual.rename(from, to);
      } catch (error) {
        conflicts.push((error as NodeJS.ErrnoException).code!);
        release.resolve();
        await reader;
        throw error;
      }
    });
    try {
      const write = part === "state" ? store.updateState(run, { settled: true }) : store.save({ ...run, settled: true });
      await expect(write).resolves.toBeUndefined();
      expect(conflicts).toEqual(["EPERM"]);
      expect(await reader).toEqual({ runs: [run], unreadable: false });
      expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [{ ...run, settled: true }], unreadable: false });
      expect((await actual.readdir(folder)).some(name => name.includes(".tmp-"))).toBe(false);
    } finally {
      release.resolve();
      await reader;
    }
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
