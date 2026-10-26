import * as disk from "node:fs/promises";
import { join } from "node:path";
import * as timers from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomationRunStore, type StoredRun } from "./automationRunStore";
import { createTestScratch, testStoreFolder } from "./testScratch";

const io = vi.hoisted(() => ({
  rename: vi.fn<typeof disk.rename>(), delay: vi.fn<typeof timers.setTimeout>(),
  readFile: vi.fn<typeof disk.readFile>(), open: vi.fn<typeof disk.open>(), lstat: vi.fn<typeof disk.lstat>(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof disk>(), rename: io.rename, readFile: io.readFile, open: io.open, lstat: io.lstat,
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
  io.lstat.mockImplementation(actual.lstat);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function savedRun(withWake = false) {
  const root = await createTestScratch("dohc-run-store-windows-");
  const store = createAutomationRunStore(testStoreFolder(root));
  const run: StoredRun = {
    durableEffects: 0, version: 13, claimId: "reader", automationId: "collection:Tasks#bump",
    definitionHash: "0123456789abcdef", keySeed: "0123456789abcdef",
    startedAtMs: 1, finishedAtMs: 1, steps: [], applied: [], created: [], replans: [],
    undoRequests: [], undoCalls: [], undoCovers: [], readableFields: null,
    collections: [], rules: null, superseded: false, undo: null, undoKept: [],
    settled: false, outcome: { state: "done" },
  };
  if (withWake) {
    run.steps = [{ ordinal: 0, effects: [{ kind: "set", target: { recordId: "a", collectionPath: "Tasks", path: "Tasks/a.md" }, fields: [] }] }];
    run.applied = [{ ordinal: 0, writes: [{ kind: "notice", noticeId: "wake", name: "Ice" }] }];
  }
  await store.save(run);
  const runs = join(root, ".dohc", "local", "automations", "runs");
  const folder = join(runs, (await actual.readdir(runs))[0]!);
  const path = join(folder, (await actual.readdir(folder)).find(name => name.endsWith(".json"))!);
  io.rename.mockClear();
  const progressPath = path;
  return { root, store, run, folder, path, progressPath };
}

describe.skipIf(process.platform !== "win32")("Windows run-store replacement", () => {
  it.each(["save", "updateState"])("queues %s behind an in-process history read", async (operation) => {
    const { root, store, run, path } = await savedRun();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    // A read opens the file with numeric flags; a write opens a temporary name.
    io.open.mockImplementation(async (file, flags, mode) => {
      if (file === path && typeof flags === "number" && !held) {
        held = true;
        reading.resolve();
        await release.promise;
      }
      return actual.open(file, flags, mode);
    });
    const history = createAutomationRunStore(testStoreFolder(root)).runsOf(run.automationId, run.claimId);
    await reading.promise;
    const write = operation === "save" ? store.save({ ...run, settled: true }) : store.updateState(run, { settled: true });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(io.rename).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([history, write]);
    }
    expect(await history).toEqual({ runs: [run], unreadable: false });
    expect(io.rename).toHaveBeenCalledTimes(1);
    expect(io.delay).not.toHaveBeenCalled();
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
    const restarted = createAutomationRunStore(testStoreFolder(root));
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
describe("single-file run saves", () => {
  it("keeps the previous complete run when publication fails, including after reopening", async () => {
    const { root, store, run, path, folder } = await savedRun();
    const before = await actual.readFile(path, "utf8");
    const files = await actual.readdir(folder);
    const error = Object.assign(new Error("run replacement failed"), { code: "EIO" });
    io.rename.mockImplementation(async (from, to) => {
      if (to === path) throw error;
      return actual.rename(from, to);
    });
    const next = { ...run, settled: true, steps: [{ ordinal: 0, effects: [] }] };
    await expect(store.save(next)).rejects.toBe(error);
    expect(await actual.readFile(path, "utf8")).toBe(before);
    for (const reader of [store, createAutomationRunStore(testStoreFolder(root))]) {
      expect(await reader.runsOf(run.automationId, run.claimId)).toEqual({ runs: [run], unreadable: false });
    }
    expect(await actual.readdir(folder)).toEqual(files);
  });

  it.each(["open", "write", "sync", "close", "rename", "directory-sync"])("reopens a consistent run after failure at %s", async (point) => {
    const { root, store, run, path, folder } = await savedRun();
    const error = Object.assign(new Error(point), { code: "EIO" });
    if (point === "directory-sync") vi.stubGlobal("process", { ...process, platform: "linux" });
    io.open.mockImplementation(async (file, flags, mode) => {
      if (file === folder && flags === "r") {
        const handle = await actual.open(path, "r");
        handle.sync = async () => { throw error; };
        return handle;
      }
      const temporary = String(file).includes(".tmp-");
      if (temporary && point === "open") throw error;
      const handle = await actual.open(file, flags, mode);
      if (temporary && point === "write") handle.writeFile = async () => { throw error; };
      if (temporary && point === "sync") handle.sync = async () => { throw error; };
      if (temporary && point === "close") {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); throw error; };
      }
      return handle;
    });
    if (point === "rename") io.rename.mockRejectedValue(error);
    const next = { ...run, settled: true, steps: [{ ordinal: 0, effects: [] }] };
    await expect(store.save(next)).rejects.toBe(error);
    const expected = point === "directory-sync" ? next : run;
    expect(await createAutomationRunStore(testStoreFolder(root)).runsOf(run.automationId, run.claimId)).toEqual({ runs: [expected], unreadable: false });
    expect((await actual.readdir(folder)).some(file => file.includes(".tmp-"))).toBe(false);
    expect(await actual.readFile(path, "utf8")).toContain(expected.settled ? '"settled":true' : '"settled":false');
  });

  it("keeps one file after repeated whole saves and state rewrites", async () => {
    const { root, store, run, folder } = await savedRun();
    for (let i = 0; i < 8; i += 1) {
      await store.save(run);
      await store.updateState(run, { settled: true });
    }
    expect(await actual.readdir(folder)).toHaveLength(1);
    expect(await createAutomationRunStore(testStoreFolder(root)).runsOf(run.automationId, run.claimId)).toEqual({ runs: [{ ...run, settled: true }], unreadable: false });
  });

  it("appends a complete line without reading or replacing the header", async () => {
    const { store, run } = await savedRun();
    io.readFile.mockClear();
    const step = { ordinal: 0, effects: [] };
    await store.appendStep(run, step);
    expect(io.readFile).not.toHaveBeenCalled();
    expect(io.rename).not.toHaveBeenCalled();
    expect(await store.runsOf(run.automationId, run.claimId)).toEqual({ runs: [{ ...run, steps: [step] }], unreadable: false });
  });

  it.each(["win32", "linux"].flatMap(platform => ["state", "wake", "end"].map(operation => ({ platform, operation }))))("orders appends around a $operation rewrite across stores on $platform", async ({ platform, operation }) => {
    const { root, store, run, path, folder } = await savedRun(true);
    if (operation === "end") {
      run.finishedAtMs = null;
      run.outcome = null;
      await store.save(run);
    }
    vi.stubGlobal("process", { ...process, platform });
    const writer = createAutomationRunStore(testStoreFolder(root));
    const before = { ordinal: 1, effects: [] };
    await writer.appendStep(run, before);
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    io.open.mockImplementation(async (file, flags, mode) => {
      // Node cannot open directories on Windows. Emulate only POSIX fsync.
      if (flags === "r" && (await actual.lstat(file)).isDirectory()) {
        const handle = await actual.open(path, "r");
        handle.sync = async () => undefined;
        return handle;
      }
      const handle = await actual.open(file, flags, mode);
      if (String(file).startsWith(`${path}.tmp-`)) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); staged.resolve(); await release.promise; };
      }
      return handle;
    });
    const rewrite = operation === "state" ? store.updateState(run, { settled: true })
      : operation === "wake" ? store.supersedeWake(run.automationId, run.claimId, run.keySeed, "wake", "later")
      : store.expire(1000, async () => "settled", null);
    await staged.promise;
    io.open.mockClear();
    const entered = Promise.withResolvers<void>();
    io.lstat.mockImplementation((async (file, options) => {
      const stats = await actual.lstat(file, options);
      if (file === folder) entered.resolve();
      return stats;
    }) as typeof disk.lstat);
    const after = { ordinal: 2, effects: [] };
    const append = writer.appendStep(run, after);
    try {
      await entered.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(io.open.mock.calls.some(([, flags]) => flags === "a")).toBe(false);
    } finally {
      release.resolve();
      await Promise.all([rewrite, append]);
    }
    const expected = { ...run, steps: [...run.steps, before, after] };
    if (operation === "state") expected.settled = true;
    if (operation === "end") expected.finishedAtMs = 1000;
    if (operation === "wake") expected.applied = [{ ordinal: 0, writes: [{ kind: "notice", noticeId: "wake", name: "Ice; agent wake superseded by a later run", supersededBy: "later" }] }];
    expect(await createAutomationRunStore(testStoreFolder(root)).runsOf(run.automationId, run.claimId)).toEqual({ runs: [expected], unreadable: false });
  });

  it("ignores crash-left staging files and removes them even before a run's first publication", async () => {
    const { root, store, run, path, folder } = await savedRun();
    const text = await actual.readFile(path, "utf8");
    const leftovers = ["", "{", text.slice(0, text.indexOf("\n") + 1), text];
    for (let i = 0; i < leftovers.length; i += 1) await actual.writeFile(`${path}.tmp-999-${i}`, leftovers[i]!);
    expect(await createAutomationRunStore(testStoreFolder(root)).runsOf(run.automationId, run.claimId)).toEqual({ runs: [run], unreadable: false });
    await actual.rm(path);
    const reopened = createAutomationRunStore(testStoreFolder(root));
    expect(await reopened.runsOf(run.automationId, run.claimId)).toEqual({ runs: [], unreadable: false });
    await reopened.expire(1000, async () => "gone", null);
    await expect(actual.readdir(folder)).rejects.toMatchObject({ code: "ENOENT" });
    await store.save(run);
    await actual.writeFile(`${path}.tmp-999-published`, text);
    await createAutomationRunStore(testStoreFolder(root)).expire(30 * 24 * 60 * 60 * 1000 + 1000, async () => "gone", null);
    await expect(actual.readdir(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
