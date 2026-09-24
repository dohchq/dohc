import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsIpc } from "./settingsIpc";
import { CHANNELS } from "./channels";
import { WorkspaceUiState } from "./bridgeContract";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../settings/userSettings";
import * as userSettingsStore from "../settings/userSettingsStore";
import * as workspaceSettingsFile from "../workspaces/workspaceSettingsFile";
import * as uiStateStore from "../workspaces/workspaceUiState";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import { RendererWorkspaceSessionOwner, type RendererWorkspaceSession } from "../window/rendererWorkspaceSessionOwner";
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace } from "../workspaces/workspaceAuthorityOwner";
import type { RegistryEntry } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";

const DOCUMENT = "123e4567-e89b-42d3-a456-426614174001";
const state = WorkspaceUiState.parse({
  version: 2, activeView: "explorer", sidebarVisible: true, sidebarWidth: 320,
  editorGroups: [{ id: "main", tabs: [], activeTab: null, size: 1 }], activeEditorGroup: "main",
});
const settingsPayload = { settings: DEFAULT_USER_SETTINGS, base: DEFAULT_USER_SETTINGS };
const workspacePayload = { workspaceId: "workspace-a" };
const patchPayload = { ...workspacePayload, patch: { agents: { mcpAutoStart: false } } };
const uiPayload = { ...workspacePayload, state };
const settingsRequests = [
  [CHANNELS.getUserSettings, undefined],
  [CHANNELS.reloadUserSettings, undefined],
  [CHANNELS.setUserSettings, settingsPayload],
  [CHANNELS.resetUserSettings, undefined],
  [CHANNELS.getUserSettingsFilePath, undefined],
  [CHANNELS.openUserSettingsFile, undefined],
  [CHANNELS.openWorkspaceSettingsFile, workspacePayload],
  [CHANNELS.getWorkspaceSettings, workspacePayload],
  [CHANNELS.setWorkspaceSettings, patchPayload],
  [CHANNELS.resetWorkspaceSettings, workspacePayload],
] as const;
const workspaceRequests = [
  [CHANNELS.getWorkspaceSettings, workspacePayload],
  [CHANNELS.setWorkspaceSettings, patchPayload],
  [CHANNELS.resetWorkspaceSettings, workspacePayload],
  [CHANNELS.getWorkspaceUiState, workspacePayload],
  [CHANNELS.setWorkspaceUiState, uiPayload],
] as const;
const requests = [...settingsRequests, ...workspaceRequests.slice(3)];
const dispose: Array<() => Promise<void>> = [];

function sender(id: number) {
  return { id, isDestroyed: () => false, once(_event: "destroyed", _listener: () => void) { return this; } };
}
type Sender = ReturnType<typeof sender>;
type Event = { sender: Sender; trusted: boolean };
type Operation = ExactRendererWorkspaceOperation<PhysicalWorkspace<RegistryEntry>, object, RendererWorkspaceSession<Sender>>;

async function harness() {
  let stateDirectory = await createTestScratch("settings-ipc-user-");
  const roots = await Promise.all([createTestScratch("settings-ipc-a-"), createTestScratch("settings-ipc-b-")]);
  const entries = new Map<string, RegistryEntry>(["workspace-a", "workspace-b"].map((workspaceId, index) => [workspaceId, {
    workspaceId, rootPath: roots[index]!, kind: "personal", mode: "local-first",
  }]));
  const authorities = createWorkspaceAuthorityOwner<RegistryEntry, object>({
    findWorkspace: id => entries.get(id) ?? null, canonicalizeRoot: root => root, createState: () => ({}),
  });
  const sessions = new RendererWorkspaceSessionOwner<Sender>({
    retirement: {
      retireSender: () => ({ requiredForAdmission: Promise.resolve(), detachedFromAdmission: Promise.resolve() }),
      retireWorkspace: async () => undefined,
    },
  });
  const first = sender(1), second = sender(2);
  const open = async (value: Sender, workspaceId: string) => {
    const workspace = await authorities.withOperation(workspaceId, operation => operation.workspace);
    return sessions.open(value, workspace, DOCUMENT);
  };
  await open(first, "workspace-a");
  await open(second, "workspace-b");
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<Sender, PhysicalWorkspace<RegistryEntry>, object, RendererWorkspaceSession<Sender>>({
    currentSession: value => sessions.current(value),
    withPhysicalOperation: (id, work) => authorities.withOperation(id, work),
  });
  let preferredName: string | undefined = "Before";
  const effects: Array<{ kind: string; value: unknown; persisted: DesktopUserSettings }> = [];
  const persisted = () => JSON.parse(readFileSync(join(stateDirectory, userSettingsStore.USER_SETTINGS_FILE), "utf8")) as DesktopUserSettings;
  const setCachedPreferredName = vi.fn((value: string | undefined) => {
    preferredName = value;
    effects.push({ kind: "name", value, persisted: persisted() });
  });
  const applyZoomLevelToWindows = vi.fn((value: number) => { effects.push({ kind: "zoom", value, persisted: persisted() }); });
  const broadcastUserSettings = vi.fn();
  const notifyRenderer = vi.fn();
  const refreshDispatchTray = vi.fn<() => Promise<unknown>>(async () => undefined);
  const openDispatchWorkspaces = vi.fn(() => [...entries.values()]);
  const scanWorkspace = vi.fn<(workspaceId: string) => Promise<unknown>>(async () => undefined);
  const openPath = vi.fn<(path: string) => Promise<string>>(async () => "");
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const capability = createSettingsIpc<Sender, Event, Operation>({
    registerHandler: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    assertTrustedSender: event => { if (!event.trusted) throw new Error("untrusted"); },
    stateDir: () => stateDirectory, setCachedPreferredName,
    applyZoomLevelToWindows, refreshDispatchTray, openDispatchWorkspaces,
    chatDispatchService: { scanWorkspace }, withRendererWorkspaceOperation,
    broadcastUserSettings, notifyRenderer, openPath,
  });
  capability.registerSettingsIpcHandlers();
  const firstGroup = [...handlers.keys()];
  capability.registerWorkspaceUiStateIpcHandlers();
  dispose.push(async () => {
    await Promise.all([sessions.retireAfterCrash(first), sessions.retireAfterCrash(second)]);
    await authorities.close();
  });
  return {
    handlers, firstGroup, effects, entries, authorities, sessions, first, second, open,
    zoom: capability.stepWindowZoom, setCachedPreferredName, applyZoomLevelToWindows,
    refreshDispatchTray, openDispatchWorkspaces, scanWorkspace, broadcastUserSettings, notifyRenderer,
    openPath, reload: capability.reloadUserSettings,
    preferredName: () => preferredName, stateDirectory: () => stateDirectory,
    setStateDirectory: (value: string) => { stateDirectory = value; },
    root: entries.get("workspace-a")!.rootPath, otherRoot: entries.get("workspace-b")!.rootPath,
    invoke: async (channel: string, payload?: unknown, value = first, trusted = true) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing handler: ${channel}`);
      return handler({ sender: value, trusted }, payload);
    },
  };
}

afterEach(async () => {
  try { for (const close of dispose.splice(0)) await close(); }
  finally { vi.restoreAllMocks(); }
});

describe("registered settings IPC", () => {
  it("registers the settings callbacks and the later UI-state pair", async () => {
    const h = await harness();
    expect(h.firstGroup).toEqual(settingsRequests.map(([channel]) => channel));
    expect([...h.handlers.keys()]).toEqual(requests.map(([channel]) => channel));
  });

  it("rejects untrusted calls before reading, writing, or updating the application", async () => {
    const h = await harness();
    const reads = vi.spyOn(userSettingsStore, "readCachedUserSettingsFile");
    const writes = vi.spyOn(userSettingsStore, "writeUserSettingsFile");
    const workspaceReads = vi.spyOn(workspaceSettingsFile, "readWorkspaceSettingsFile");
    const workspaceWrites = vi.spyOn(workspaceSettingsFile, "saveWorkspaceSettingsFile");
    const resets = vi.spyOn(workspaceSettingsFile, "resetWorkspaceSettingsFile");
    const uiReads = vi.spyOn(uiStateStore, "readUiStateFile");
    const uiWrites = vi.spyOn(uiStateStore, "writeUiStateFile");
    for (const [channel, payload] of requests) await expect(h.invoke(channel, payload, h.first, false)).rejects.toThrow("untrusted");
    for (const port of [reads, writes, workspaceReads, workspaceWrites, resets, uiReads, uiWrites, h.openPath]) expect(port).not.toHaveBeenCalled();
    expect(h.effects).toEqual([]);
    expect(h.refreshDispatchTray).not.toHaveBeenCalled();
    expect(h.scanWorkspace).not.toHaveBeenCalled();
  });

  it("rejects malformed writes and workspace payloads before file access", async () => {
    const h = await harness();
    const writes = vi.spyOn(userSettingsStore, "writeUserSettingsFile");
    const workspaceReads = vi.spyOn(workspaceSettingsFile, "readWorkspaceSettingsFile");
    const workspaceWrites = vi.spyOn(workspaceSettingsFile, "saveWorkspaceSettingsFile");
    const resets = vi.spyOn(workspaceSettingsFile, "resetWorkspaceSettingsFile");
    const uiReads = vi.spyOn(uiStateStore, "readUiStateFile");
    const uiWrites = vi.spyOn(uiStateStore, "writeUiStateFile");
    for (const channel of [CHANNELS.setUserSettings, ...workspaceRequests.map(([channel]) => channel)]) {
      await expect(h.invoke(channel, {})).rejects.toThrow();
    }
    await expect(h.invoke(CHANNELS.setUserSettings, { settings: { ...DEFAULT_USER_SETTINGS, runner: { command: " ", enabled: true, timeoutMinutes: 30 } }, base: DEFAULT_USER_SETTINGS })).rejects.toThrow();
    await expect(h.invoke(CHANNELS.setWorkspaceUiState, { ...uiPayload, state: { ...state, sidebarWidth: -1 } })).rejects.toThrow();
    for (const port of [writes, workspaceReads, workspaceWrites, resets, uiReads, uiWrites]) expect(port).not.toHaveBeenCalled();
    expect(h.effects).toEqual([]);
  });

  it("reads defaults, refreshes cached reads after save, and resets the persisted user settings", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.getUserSettings)).resolves.toEqual({ settings: DEFAULT_USER_SETTINGS, source: "default" });
    const settings = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Sam" }, appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 2 } };
    await expect(h.invoke(CHANNELS.setUserSettings, { settings, base: DEFAULT_USER_SETTINGS })).resolves.toEqual({ settings, source: "stored" });
    expect(h.preferredName()).toBe("Sam");
    await expect(h.invoke(CHANNELS.getUserSettings)).resolves.toEqual({ settings, source: "stored" });
    await expect(h.invoke(CHANNELS.resetUserSettings)).resolves.toEqual({ settings: DEFAULT_USER_SETTINGS, source: "stored" });
    expect(h.broadcastUserSettings).toHaveBeenLastCalledWith({ settings: DEFAULT_USER_SETTINGS, source: "stored" });
    expect(h.preferredName()).toBeUndefined();
    expect(h.effects.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: "name", value: "Sam" }, { kind: "zoom", value: 2 },
      { kind: "name", value: undefined }, { kind: "zoom", value: 0 },
    ]);
    for (const effect of h.effects) {
      expect(effect.value).toEqual(effect.kind === "name" ? effect.persisted.profile.preferredName : effect.persisted.appearance.zoomLevel);
    }
    expect(h.refreshDispatchTray).toHaveBeenCalledTimes(2);
    expect(h.openDispatchWorkspaces).not.toHaveBeenCalled();
  });

  it("serializes settings saves, menu zoom, and reset on the shared user queue", async () => {
    const h = await harness();
    const reached = deferred(), release = deferred();
    const realWrite = userSettingsStore.writeUserSettingsFile;
    const writes = vi.spyOn(userSettingsStore, "writeUserSettingsFile").mockImplementationOnce(async (dir, settings, base) => {
      reached.resolve(); await release.promise; return realWrite(dir, settings, base);
    });
    const firstSettings = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "First" }, appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 1 } };
    const nextSettings = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Next" }, appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: -2 } };
    const first = h.invoke(CHANNELS.setUserSettings, { settings: firstSettings, base: DEFAULT_USER_SETTINGS });
    const pending = [first];
    try {
      await reached.promise;
      const next = h.invoke(CHANNELS.setUserSettings, { settings: nextSettings, base: DEFAULT_USER_SETTINGS });
      const zoom = h.zoom("in");
      const reset = h.invoke(CHANNELS.resetUserSettings);
      pending.push(next, zoom, reset);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(h.effects).toEqual([]);
      expect(h.preferredName()).toBe("Before");
      expect(h.refreshDispatchTray).not.toHaveBeenCalled();
      release.resolve();
      await expect(first).resolves.toEqual({ settings: firstSettings, source: "stored" });
      await expect(next).resolves.toEqual({ settings: nextSettings, source: "stored" });
      await expect(zoom).resolves.toMatchObject({ settings: { appearance: { zoomLevel: -1 } } });
      await expect(reset).resolves.toEqual({ settings: DEFAULT_USER_SETTINGS, source: "stored" });
      // The zoom step reads the file the save before it wrote; reset replaces
      // the file rather than saving into it.
      expect(writes.mock.calls.map(([, settings]) => settings.appearance.zoomLevel)).toEqual([1, -2]);
      // Every change puts the whole file into effect, the zoom step included.
      expect(h.setCachedPreferredName.mock.calls).toEqual([["First", undefined], ["Next", undefined], ["Next", undefined], [undefined, undefined]]);
      expect(h.applyZoomLevelToWindows.mock.calls).toEqual([[1], [-2], [-1], [0]]);
      await expect(userSettingsStore.readUserSettingsFile(h.stateDirectory())).resolves.toEqual({ settings: DEFAULT_USER_SETTINGS, source: "stored" });
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("leaves name, zoom, and dispatch untouched after persistence fails and permits the next write", async () => {
    const h = await harness();
    const directory = h.stateDirectory();
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "keep");
    h.setStateDirectory(blocked);
    const named = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Sam" } };
    await expect(h.invoke(CHANNELS.setUserSettings, { settings: named, base: DEFAULT_USER_SETTINGS })).rejects.toThrow();
    expect(h.preferredName()).toBe("Before");
    expect(h.effects).toEqual([]);
    expect(h.refreshDispatchTray).not.toHaveBeenCalled();
    expect(h.scanWorkspace).not.toHaveBeenCalled();
    expect(await readFile(blocked, "utf8")).toBe("keep");
    h.setStateDirectory(directory);
    await expect(h.invoke(CHANNELS.resetUserSettings)).resolves.toEqual({ settings: DEFAULT_USER_SETTINGS, source: "stored" });
    expect(h.preferredName()).toBeUndefined();
  });

  it("resolves the current state directory when a queued save actually runs", async () => {
    const h = await harness();
    const oldDirectory = h.stateDirectory();
    const reached = deferred(), release = deferred();
    const realRead = userSettingsStore.readCachedUserSettingsFile;
    // Holds the queue at the start of the save's turn.
    vi.spyOn(userSettingsStore, "readCachedUserSettingsFile").mockImplementationOnce(async (dir) => {
      reached.resolve(); await release.promise; return realRead(dir);
    });
    const named = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Queued" } };
    const saving = h.invoke(CHANNELS.setUserSettings, { settings: named, base: DEFAULT_USER_SETTINGS });
    try {
      await reached.promise;
      h.setStateDirectory(await createTestScratch("settings-ipc-next-user-"));
      release.resolve();
      await saving;
      await expect(userSettingsStore.readUserSettingsFile(oldDirectory)).resolves.toMatchObject({ source: "default" });
      await expect(userSettingsStore.readUserSettingsFile(h.stateDirectory())).resolves.toEqual({ settings: named, source: "stored" });
    } finally {
      release.resolve();
      await Promise.allSettled([saving]);
    }
  });

  it("waits for tray refresh then starts each enabled runner scan with its own rejection handler", async () => {
    const h = await harness();
    const trayReached = deferred(), trayRelease = deferred(), scanRelease = deferred(), logged = deferred();
    const error = new Error("first workspace scan failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => { logged.resolve(); });
    h.refreshDispatchTray.mockImplementationOnce(async () => { trayReached.resolve(); await trayRelease.promise; });
    h.scanWorkspace.mockRejectedValueOnce(error).mockImplementationOnce(() => scanRelease.promise);
    const settings = { ...DEFAULT_USER_SETTINGS, profile: { agentName: "Nova" }, runner: { command: "agent run", enabled: true, timeoutMinutes: 30 } };
    const result = h.invoke(CHANNELS.setUserSettings, { settings, base: DEFAULT_USER_SETTINGS });
    try {
      await trayReached.promise;
      expect(h.scanWorkspace).not.toHaveBeenCalled();
      expect(h.openDispatchWorkspaces).not.toHaveBeenCalled();
      trayRelease.resolve();
      await expect(result).resolves.toEqual({ settings, source: "stored" });
      await logged.promise;
      expect(h.scanWorkspace.mock.calls).toEqual([["workspace-a"], ["workspace-b"]]);
      expect(log).toHaveBeenCalledExactlyOnceWith("[desktop] runner-settings dispatch scan:", error);
      expect(h.notifyRenderer).not.toHaveBeenCalled();
      scanRelease.resolve();
      await vi.waitFor(() => expect(h.notifyRenderer).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-b" }));
    } finally {
      trayRelease.resolve();
      scanRelease.resolve();
      await Promise.allSettled([result]);
    }
  });

  it("propagates a tray failure after persistence and skips runner scans", async () => {
    const h = await harness();
    const error = new Error("tray unavailable");
    h.refreshDispatchTray.mockRejectedValueOnce(error);
    const settings = { ...DEFAULT_USER_SETTINGS, profile: { agentName: "Nova" }, runner: { command: "agent run", enabled: true, timeoutMinutes: 30 } };
    await expect(h.invoke(CHANNELS.setUserSettings, { settings, base: DEFAULT_USER_SETTINGS })).rejects.toBe(error);
    await expect(userSettingsStore.readUserSettingsFile(h.stateDirectory())).resolves.toEqual({ settings, source: "stored" });
    expect(h.effects).toHaveLength(2);
    expect(h.scanWorkspace).not.toHaveBeenCalled();
  });

  it("applies a hand edit of the settings file as a save does, and finds nothing new after dohc's own save", async () => {
    const h = await harness();
    const path = join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE);
    await h.invoke(CHANNELS.setUserSettings, { settings: { ...DEFAULT_USER_SETTINGS, appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 1 } }, base: DEFAULT_USER_SETTINGS });
    h.broadcastUserSettings.mockClear();
    h.applyZoomLevelToWindows.mockClear();
    h.refreshDispatchTray.mockClear();
    // The watcher fires for dohc's own save too; that reload changes nothing.
    await h.reload();
    expect(h.broadcastUserSettings).not.toHaveBeenCalled();
    expect(h.applyZoomLevelToWindows).not.toHaveBeenCalled();
    expect(h.refreshDispatchTray).not.toHaveBeenCalled();

    await writeFile(path, JSON.stringify({
      appearance: { themeMode: "dark", zoomLevel: 3 },
      profile: { preferredName: "Ada" },
      fancyBorders: true,
    }));
    await h.reload();
    const applied = {
      settings: { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Ada" }, appearance: { themeMode: "dark", zoomLevel: 3 } },
      source: "stored",
      ignored: [{ key: "fancyBorders", reason: "unknown" }],
    };
    expect(h.broadcastUserSettings).toHaveBeenCalledExactlyOnceWith(applied);
    expect(h.applyZoomLevelToWindows).toHaveBeenCalledExactlyOnceWith(3);
    expect(h.preferredName()).toBe("Ada");
    expect(h.refreshDispatchTray).toHaveBeenCalledOnce();
    await expect(h.invoke(CHANNELS.getUserSettings)).resolves.toEqual(applied);
  });

  it("steps zoom from the file as it is now and puts a hand edit it merged into effect", async () => {
    const h = await harness();
    const path = join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE);
    const dark = { ...DEFAULT_USER_SETTINGS, appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const } };
    await h.invoke(CHANNELS.setUserSettings, { settings: dark, base: DEFAULT_USER_SETTINGS });
    h.broadcastUserSettings.mockClear();
    // An edit the watcher has not applied yet: zoom 3 and a name.
    await writeFile(path, JSON.stringify({
      appearance: { themeMode: "system", zoomLevel: 3 },
      profile: { preferredName: "Ada" },
    }));
    await expect(h.zoom("in")).resolves.toMatchObject({
      settings: { appearance: { zoomLevel: 4 }, profile: { preferredName: "Ada" } },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      appearance: { themeMode: "system", zoomLevel: 4 },
      profile: { preferredName: "Ada" },
    });
    expect(h.preferredName()).toBe("Ada");
    expect(h.applyZoomLevelToWindows).toHaveBeenLastCalledWith(4);
    expect(h.broadcastUserSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ settings: expect.objectContaining({ profile: { preferredName: "Ada" } }) }),
    );
    // The zoom save already applied the edit; the watcher finds nothing new.
    await h.reload();
    expect(h.broadcastUserSettings).toHaveBeenCalledOnce();
  });

  it("refuses a zoom step over a file dohc cannot use, and names the way out", async () => {
    const h = await harness();
    const path = join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE);
    await writeFile(path, "{ \"appearance\": ");
    await expect(h.zoom("in")).rejects.toThrow(
      `dohc did not save settings. dohc could not use ${path}: it is not valid JSON. Fix the file, or select Reset user in Advanced to replace it.`,
    );
    expect(await readFile(path, "utf8")).toBe("{ \"appearance\": ");
    expect(h.applyZoomLevelToWindows).not.toHaveBeenCalled();
  });

  it("scans for waiting runner work only when the runner or the agent's name changes", async () => {
    const h = await harness();
    const runner = { ...DEFAULT_USER_SETTINGS, profile: { agentName: "Nova" }, runner: { command: "agent run", enabled: true, timeoutMinutes: 30 } };
    await h.invoke(CHANNELS.setUserSettings, { settings: runner, base: DEFAULT_USER_SETTINGS });
    await vi.waitFor(() => expect(h.scanWorkspace).toHaveBeenCalledTimes(2));
    h.scanWorkspace.mockClear();
    await h.zoom("in");
    await h.invoke(CHANNELS.setUserSettings, {
      settings: { ...runner, profile: { ...runner.profile, preferredName: "Sam" } },
      base: runner,
    });
    expect(h.scanWorkspace).not.toHaveBeenCalled();
    expect(h.refreshDispatchTray).toHaveBeenCalledTimes(3);
  });

  it("opens this workspace's settings file through the workspace that asked", async () => {
    const h = await harness();
    await workspaceSettingsFile.saveWorkspaceSettingsFile(h.root, { privacy: { confirmExternalLinks: false } });
    await h.invoke(CHANNELS.openWorkspaceSettingsFile, workspacePayload);
    expect(h.openPath).toHaveBeenCalledExactlyOnceWith(join(h.root, ".dohc", workspaceSettingsFile.WORKSPACE_SETTINGS_FILE));
    await expect(h.invoke(CHANNELS.openWorkspaceSettingsFile, workspacePayload, h.second)).rejects.toThrow("this window changed workspaces");
    expect(h.openPath).toHaveBeenCalledOnce();
  });

  it("creates the settings file before opening it, and never replaces one that exists", async () => {
    const h = await harness();
    const path = join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE);
    await expect(h.invoke(CHANNELS.getUserSettingsFilePath)).resolves.toBe(path);
    await h.invoke(CHANNELS.openUserSettingsFile);
    expect(h.openPath).toHaveBeenCalledExactlyOnceWith(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(DEFAULT_USER_SETTINGS);
    await h.reload();
    expect(h.broadcastUserSettings).not.toHaveBeenCalled();

    await writeFile(path, "{ \"appearance\": ");
    await h.invoke(CHANNELS.openUserSettingsFile);
    expect(await readFile(path, "utf8")).toBe("{ \"appearance\": ");
    h.openPath.mockResolvedValueOnce("No application is associated with this file.");
    await expect(h.invoke(CHANNELS.openUserSettingsFile)).rejects.toThrow(
      `dohc could not open ${path}. No application is associated with this file. Open the file in a text editor.`,
    );
  });
});

describe("registered workspace settings and UI state", () => {
  it("uses real renderer and physical attachment admission for every workspace callback", async () => {
    const h = await harness();
    const reads = vi.spyOn(workspaceSettingsFile, "readWorkspaceSettingsFile");
    const writes = vi.spyOn(workspaceSettingsFile, "saveWorkspaceSettingsFile");
    const resets = vi.spyOn(workspaceSettingsFile, "resetWorkspaceSettingsFile");
    const uiReads = vi.spyOn(uiStateStore, "readUiStateFile");
    const uiWrites = vi.spyOn(uiStateStore, "writeUiStateFile");
    for (const [channel, payload] of workspaceRequests) {
      await expect(h.invoke(channel, payload, h.second)).rejects.toThrow("this window changed workspaces");
      await expect(h.invoke(channel, payload, sender(3))).rejects.toThrow("this window changed workspaces");
    }
    await h.authorities.invalidate("workspace-a");
    for (const [channel, payload] of workspaceRequests) await expect(h.invoke(channel, payload)).rejects.toThrow("this window changed workspaces");
    for (const port of [reads, writes, resets, uiReads, uiWrites]) expect(port).not.toHaveBeenCalled();
  });

  it("merges workspace patches onto disk and resets only the admitted workspace", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.getWorkspaceSettings, workspacePayload)).resolves.toEqual({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" });
    await workspaceSettingsFile.saveWorkspaceSettingsFile(h.root, { agents: { defaultModel: "external-model" } });
    await workspaceSettingsFile.saveWorkspaceSettingsFile(h.otherRoot, { agents: { defaultModel: "other-model" } });
    const saved = await h.invoke(CHANNELS.setWorkspaceSettings, patchPayload);
    expect(saved).toMatchObject({ settings: { agents: { mcpAutoStart: false, defaultModel: "external-model" } }, source: "stored" });
    await expect(h.invoke(CHANNELS.getWorkspaceSettings, workspacePayload)).resolves.toEqual(saved);
    await expect(h.invoke(CHANNELS.resetWorkspaceSettings, workspacePayload)).resolves.toEqual({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "stored" });
    await expect(workspaceSettingsFile.readWorkspaceSettingsFile(h.otherRoot)).resolves.toMatchObject({ settings: { agents: { defaultModel: "other-model" } } });
  });

  it("keeps recovery warnings and save refusals from the real settings file owner", async () => {
    const h = await harness();
    await mkdir(join(h.root, ".dohc"));
    const path = join(h.root, ".dohc", workspaceSettingsFile.WORKSPACE_SETTINGS_FILE);
    await writeFile(path, "{broken");
    const read = await h.invoke(CHANNELS.getWorkspaceSettings, workspacePayload);
    expect(read).toMatchObject({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "recovered", warning: expect.stringContaining(path) });
    await expect(h.invoke(CHANNELS.setWorkspaceSettings, patchPayload)).resolves.toMatchObject({ source: "recovered", refusal: expect.stringContaining(path) });
    expect(await readFile(path, "utf8")).toBe("{broken");
    await expect(h.invoke(CHANNELS.resetWorkspaceSettings, workspacePayload)).resolves.toEqual({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "stored" });
  });

  it.each(["renderer", "physical"])("suppresses a held workspace settings read after %s retirement", async owner => {
    const h = await harness();
    const reached = deferred(), release = deferred();
    const realRead = workspaceSettingsFile.readWorkspaceSettingsFile;
    vi.spyOn(workspaceSettingsFile, "readWorkspaceSettingsFile").mockImplementationOnce(async root => {
      const result = await realRead(root); reached.resolve(); await release.promise; return result;
    });
    const result = h.invoke(CHANNELS.getWorkspaceSettings, workspacePayload);
    const rejection = expect(result).rejects.toThrow();
    let retirement: Promise<unknown> | undefined;
    try {
      await reached.promise;
      retirement = owner === "renderer" ? h.open(h.first, "workspace-b") : h.authorities.invalidate("workspace-a");
      if (owner === "renderer") await retirement;
    } finally {
      release.resolve();
      await Promise.all([rejection, retirement]);
    }
  });

  it("suppresses a retired save response without pretending the admitted disk write was undone", async () => {
    const h = await harness();
    const reached = deferred(), release = deferred();
    const realSave = workspaceSettingsFile.saveWorkspaceSettingsFile;
    vi.spyOn(workspaceSettingsFile, "saveWorkspaceSettingsFile").mockImplementationOnce(async (root, patch) => {
      const result = await realSave(root, patch); reached.resolve(); await release.promise; return result;
    });
    const result = h.invoke(CHANNELS.setWorkspaceSettings, patchPayload);
    const rejection = expect(result).rejects.toThrow("this window changed workspaces");
    try {
      await reached.promise;
      await h.open(h.first, "workspace-b");
    } finally {
      release.resolve();
      await rejection;
    }
    await expect(workspaceSettingsFile.readWorkspaceSettingsFile(h.root)).resolves.toMatchObject({ settings: { agents: { mcpAutoStart: false } } });
  });

  it("round-trips parsed UI state through the admitted workspace and strips unknown write fields", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.getWorkspaceUiState, workspacePayload)).resolves.toBeNull();
    await expect(h.invoke(CHANNELS.setWorkspaceUiState, { ...uiPayload, state: { ...state, extra: "discard" } })).resolves.toBeUndefined();
    await expect(h.invoke(CHANNELS.getWorkspaceUiState, workspacePayload)).resolves.toEqual(state);
    await expect(uiStateStore.readUiStateFile(h.otherRoot)).resolves.toBeNull();
  });

  it.each(["null", "[]", "7", "\"text\"", "{broken"])("returns null for unavailable or non-object UI state: %s", async raw => {
    const h = await harness();
    await mkdir(join(h.root, ".dohc"));
    await writeFile(join(h.root, ".dohc", "ui-state.json"), raw);
    await expect(h.invoke(CHANNELS.getWorkspaceUiState, workspacePayload)).resolves.toBeNull();
  });

  it("preserves raw object fields for renderer repair on UI-state reads", async () => {
    const h = await harness();
    const raw = { version: 1, activeView: "foreign", sidebarWidth: -100, extra: { retained: true } };
    await uiStateStore.writeUiStateFile(h.root, raw);
    await expect(h.invoke(CHANNELS.getWorkspaceUiState, workspacePayload)).resolves.toEqual(raw);
  });

  it.each(["read", "write"])("suppresses UI-state %s completion after renderer retirement", async kind => {
    const h = await harness();
    await uiStateStore.writeUiStateFile(h.root, state);
    const reached = deferred(), release = deferred();
    const realRead = uiStateStore.readUiStateFile, realWrite = uiStateStore.writeUiStateFile;
    if (kind === "read") vi.spyOn(uiStateStore, "readUiStateFile").mockImplementationOnce(async root => {
      const result = await realRead(root); reached.resolve(); await release.promise; return result;
    });
    else vi.spyOn(uiStateStore, "writeUiStateFile").mockImplementationOnce(async (root, value) => {
      await realWrite(root, value); reached.resolve(); await release.promise;
    });
    const result = h.invoke(kind === "read" ? CHANNELS.getWorkspaceUiState : CHANNELS.setWorkspaceUiState, kind === "read" ? workspacePayload : uiPayload);
    const rejection = expect(result).rejects.toThrow("this window changed workspaces");
    try {
      await reached.promise;
      await h.sessions.retireAfterCrash(h.first);
    } finally {
      release.resolve();
      await rejection;
    }
  });
});
