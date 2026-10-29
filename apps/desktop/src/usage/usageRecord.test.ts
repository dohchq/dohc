import { basename, dirname, join } from "node:path";
import { CLI_CAPABILITIES } from "@dohc/cli/protocol";
import { CLI_COMMANDS } from "@dohc/cli/args";
import { MCP_TOOL_CAPABILITIES } from "@dohc/mcp/tools";
import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { USAGE_ACTION_IDS } from "@dohc/workspace-contracts/usage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageRecordOperations, type UsageRecordResult } from "../ipc/bridgeContract";
import { registerOperations } from "../ipc/operationTable";
import { DESKTOP_USAGE_COVERAGE } from "./cliUsage";
import { createRendererUsage } from "./rendererUsage";
import { usageRecordHandlers, usageRecordView } from "./usageRecord";
import { createUsageStore, USAGE_SNAPSHOT_NAME, type UsageFileSystem } from "./usageStore";

type Event = { trusted: boolean };
const FILE = join("state", USAGE_SNAPSHOT_NAME);
const stores: ReturnType<typeof createUsageStore>[] = [];

function setup(options: { readError?: NodeJS.ErrnoException } = {}) {
  const disk = new Map<string, string>();
  const io = {
    readFile: vi.fn(async (path: string) => {
      if (options.readError) throw options.readError;
      const text = disk.get(path);
      if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return text;
    }),
    readdir: vi.fn(async (directory: string) => [...disk.keys()].filter(file => dirname(file) === directory).map(file => basename(file))),
    mkdir: vi.fn(async () => {}),
    copyFile: vi.fn(async (from: string, to: string) => { disk.set(to, disk.get(from)!); }),
    writeFile: vi.fn(async (path: string, data: string) => { disk.set(path, data); }),
    rename: vi.fn(async (from: string, to: string) => {
      if (!disk.has(from)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      disk.set(to, disk.get(from)!); disk.delete(from);
    }),
    link: vi.fn(async (from: string, to: string) => {
      if (disk.has(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      disk.set(to, disk.get(from)!);
    }),
    unlink: vi.fn(async (path: string) => { disk.delete(path); }),
    rm: vi.fn(async (path: string) => { disk.delete(path); }),
    sync: vi.fn(async () => {}),
    syncDirectory: vi.fn(async () => {}),
  } satisfies UsageFileSystem;
  const store = createUsageStore({ stateDir: () => "state", appVersion: "0.1.0", coverage: DESKTOP_USAGE_COVERAGE, io });
  stores.push(store);
  const record = vi.spyOn(store, "recordSuccess");
  // Main's own observers, so a count of Privacy's calls would land here.
  const counted = createRendererUsage<Event>(invocation => store.recordSuccess(invocation));
  const listeners = new Map<string, (event: Event, payload: unknown) => Promise<unknown>>();
  registerOperations<typeof usageRecordOperations, Event, never>({
    handle: (channel, listener) => { listeners.set(channel, listener); },
    assertTrustedSender: (event) => { if (!event.trusted) throw new Error("Untrusted IPC sender"); },
    withActiveWorkspace: () => { throw new Error("device scope"); },
  }, usageRecordOperations, usageRecordHandlers({ store: () => store, file: () => FILE, coverage: DESKTOP_USAGE_COVERAGE }));
  const call = (name: keyof typeof usageRecordOperations, payload: unknown, trusted = true) =>
    listeners.get(usageRecordOperations[name].channel)!({ trusted }, payload);
  return { store, io, disk, record, counted, call };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 7, 12)); });
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); vi.useRealTimers(); });

describe("usage record bridge", () => {
  it("reads every counted action with its doors' totals, coverage and last use, and never counts itself", async () => {
    const { store, record, counted, call } = setup();
    await store.load();
    store.recordSuccess({ capabilityId: "version.create", door: "renderer" });
    store.recordSuccess({ capabilityId: "version.create", door: "automation" });
    store.recordSuccess({ capabilityId: "version.create", door: "renderer" });
    record.mockClear();
    const read = await call("readUsageRecord", {}) as Extract<UsageRecordResult, { status: "readable" }>;
    expect(read).toMatchObject({ status: "readable", enabled: true, file: FILE, since: "2026-10-07" });
    expect(read.rows.map(row => row.capabilityId)).toEqual([...USAGE_ACTION_IDS]);
    expect(read.rows.find(row => row.capabilityId === "version.create")).toEqual({
      capabilityId: "version.create", label: "Create a workspace version", lastUsed: "2026-10-07",
      doors: { renderer: { count: 2, counted: true }, cli: { count: 0, counted: true },
        mcp: { count: 0, counted: true }, automation: { count: 1, counted: false } },
    });
    // The other doors this build does not count stay marked, never a plain zero.
    expect(read.rows.find(row => row.capabilityId === "chat.post")!.doors).toMatchObject({
      renderer: { counted: false }, cli: { counted: true }, mcp: { counted: true }, automation: { counted: true },
    });
    expect(record).not.toHaveBeenCalled();
    expect(Object.keys(counted)).toEqual(["version", "crash", "notice"]);
    expect(JSON.stringify(Object.values(counted).flatMap(Object.keys))).not.toMatch(/UsageRecord/);
  });

  it("switches Off keeping the saved counts, On again, and clears the counts and any temporary snapshot", async () => {
    const { store, io, disk, call } = setup();
    await store.load();
    store.recordSuccess({ capabilityId: "version.merge", door: "renderer" });
    await expect(call("setUsageRecordEnabled", { enabled: false })).resolves.toBeUndefined();
    expect(store.recordSuccess({ capabilityId: "version.merge", door: "renderer" })).toBe(false);
    let read = usageRecordView(await store.read(), DESKTOP_USAGE_COVERAGE, FILE);
    expect(read).toMatchObject({ enabled: false });
    expect(JSON.parse(disk.get(FILE)!).enabled).toBe(false);
    expect(read.status === "readable" && read.rows.find(row => row.capabilityId === "version.merge")!.doors.renderer.count).toBe(1);
    await call("setUsageRecordEnabled", { enabled: true });
    expect(store.recordSuccess({ capabilityId: "version.merge", door: "renderer" })).toBe(true);
    disk.set(`${FILE}.tmp`, "{}");
    await expect(call("clearUsageRecord", {})).resolves.toBeUndefined();
    expect(io.rm).toHaveBeenCalledWith(`${FILE}.tmp`, { force: true });
    expect(disk.has(`${FILE}.tmp`)).toBe(false);
    read = usageRecordView(await store.read(), DESKTOP_USAGE_COVERAGE, FILE);
    expect(read.status === "readable" && read.rows.every(row => row.lastUsed === null)).toBe(true);
    expect(JSON.parse(disk.get(FILE)!).counts).toEqual([]);
  });

  it("reads back the unchanged record after a Clear or switch whose write failed", async () => {
    const { store, io, call } = setup();
    await store.load();
    store.recordSuccess({ capabilityId: "version.merge", door: "renderer" });
    const merged = (read: unknown) => (read as Extract<UsageRecordResult, { status: "readable" }>)
      .rows.find(row => row.capabilityId === "version.merge")!.doors.renderer.count;
    io.rename.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(call("clearUsageRecord", {})).rejects.toThrow("disk unavailable");
    expect(merged(await call("readUsageRecord", {}))).toBe(1);
    io.rename.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(call("setUsageRecordEnabled", { enabled: false })).rejects.toThrow("disk unavailable");
    expect(await call("readUsageRecord", {})).toMatchObject({ status: "readable", enabled: true });
  });

  it("says a record it cannot read is unreadable, and changes nothing on disk", async () => {
    const { io, call } = setup({ readError: Object.assign(new Error("denied"), { code: "EACCES" }) });
    await expect(call("readUsageRecord", {})).resolves.toEqual({ status: "unreadable", file: FILE, code: "EACCES", setAside: null });
    await expect(call("clearUsageRecord", {})).rejects.toThrow("denied");
    await expect(call("setUsageRecordEnabled", { enabled: false })).rejects.toThrow("denied");
    await expect(call("startUsageRecord", {})).rejects.toThrow("denied");
    await expect(call("restoreUsageRecord", {})).rejects.toThrow("denied");
    expect(io.rename).not.toHaveBeenCalled();
    expect(io.writeFile).not.toHaveBeenCalled();
    expect(io.rm).not.toHaveBeenCalled();
  });

  it.each([
    ["bad JSON", '{"version":1,"enabled":true,"counts":['],
    ["schema mismatch", '{"version":1,"enabled":true}'],
    ["newer schema", '{"version":2,"enabled":true,"cleanExit":true,"days":[],"counts":[],"coverage":[]}'],
  ])("exposes %s to Privacy as unreadable without replacing it", async (_reason, raw) => {
    const { store, io, disk, call } = setup();
    disk.set(FILE, raw);
    await store.load();
    await expect(call("readUsageRecord", {})).resolves.toEqual({
      status: "unreadable", file: FILE, code: "INVALID_USAGE_RECORD", setAside: null,
    });
    await expect(call("clearUsageRecord", {})).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    await expect(call("setUsageRecordEnabled", { enabled: true })).rejects.toMatchObject({ code: "INVALID_USAGE_RECORD" });
    expect(store.recordSuccess({ capabilityId: "version.merge", door: "renderer" })).toBe(false);
    await vi.advanceTimersByTimeAsync(86_400_000);
    await store.close();
    expect(disk.get(FILE)).toBe(raw);
    expect(io.writeFile).not.toHaveBeenCalled();
    expect(io.rename).not.toHaveBeenCalled();
    // A launch clears only a leftover swap beside the record.
    expect(io.rm.mock.calls.filter(([file]) => !file.startsWith(`${FILE}.incoming`))).toEqual([]);
  });

  it("starts a new record Off beside an undecodable one, names it, and restores it, never counting itself", async () => {
    const { store, disk, record, call } = setup();
    disk.set(FILE, "not JSON");
    await store.load();
    record.mockClear();
    await expect(call("startUsageRecord", {})).resolves.toBeUndefined();
    await expect(call("readUsageRecord", {})).resolves.toMatchObject({
      status: "readable", enabled: false, setAside: "dohc-usage.set-aside-1.json" });
    expect(disk.get(join("state", "dohc-usage.set-aside-1.json"))).toBe("not JSON");
    await expect(call("restoreUsageRecord", {})).resolves.toBeUndefined();
    await expect(call("readUsageRecord", {})).resolves.toEqual({
      status: "unreadable", file: FILE, code: "INVALID_USAGE_RECORD", setAside: "dohc-usage.set-aside-2.json" });
    expect(disk.get(FILE)).toBe("not JSON");
    expect(record).not.toHaveBeenCalled();
    await expect(call("startUsageRecord", {}, false)).rejects.toThrow("Untrusted");
    await expect(call("restoreUsageRecord", { file: "../x" })).rejects.toThrow();
  });

  it("fails a read before the store exists instead of calling it unreadable", async () => {
    const handlers = usageRecordHandlers({ store: () => undefined, file: () => FILE, coverage: DESKTOP_USAGE_COVERAGE });
    await expect(handlers.readUsageRecord({}, { event: undefined })).rejects.toThrow("has not opened the usage record");
  });

  it("refuses bad input and untrusted senders before the store sees them", async () => {
    const { store, io, call } = setup();
    await store.load();
    io.writeFile.mockClear();
    const setEnabled = vi.spyOn(store, "setEnabled");
    const clear = vi.spyOn(store, "clear");
    for (const payload of [{ enabled: "false" }, { enabled: 0 }, {}, { enabled: false, file: "../x" }, null]) {
      await expect(call("setUsageRecordEnabled", payload)).rejects.toThrow();
    }
    for (const payload of [{ all: true }, null, "clear"]) await expect(call("clearUsageRecord", payload)).rejects.toThrow();
    await expect(call("readUsageRecord", { path: "/etc/passwd" })).rejects.toThrow();
    await expect(call("clearUsageRecord", {}, false)).rejects.toThrow("Untrusted");
    await expect(call("setUsageRecordEnabled", { enabled: false }, false)).rejects.toThrow("Untrusted");
    expect(setEnabled).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(io.writeFile).not.toHaveBeenCalled();
  });

  it("offers no CLI verb, MCP tool or other door for the record", () => {
    const ids = ["usage.read", "usage.clear", "usage.switch", "usage.start", "usage.restore"] as const;
    for (const id of ids) {
      const meta = CAPABILITIES[id];
      for (const level of ["owner", "view", "comment", "edit"] as const) expect(meta.mcp[level]).toEqual([]);
      expect(USAGE_ACTION_IDS).not.toContain(id);
    }
    const publicCapabilityIds = Object.values(CLI_COMMANDS).flatMap(command => Object.values(command.verbs).map(verb => verb.capabilityId));
    const doors = JSON.stringify([CLI_CAPABILITIES, publicCapabilityIds, MCP_TOOL_CAPABILITIES]);
    for (const id of ids) expect(doors).not.toContain(`"${id}"`);
    expect(Object.values(usageRecordOperations).map(row => [row.capabilityId, row.scope, row.guard])).toEqual(
      ids.map(id => [id, "device", "trusted-sender"]));
  });
});
