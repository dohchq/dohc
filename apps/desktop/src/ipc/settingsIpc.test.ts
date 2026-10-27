import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHistoryPresentationRequest } from "../workspaces/actorPresentation";
import { createSettingsIpc } from "./settingsIpc";
import { settingsOperations } from "./settingsOperations";
import { registerOperations } from "./operationTable";
import { OPERATION_TABLES } from "./operationTables";
import { WorkspaceUiState } from "./bridgeContract";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings, type ThemeMode } from "../settings/userSettings";
import * as userSettingsStore from "../settings/userSettingsStore";
import * as workspaceSettingsFile from "../workspaces/workspaceSettingsFile";
import * as uiStateStore from "../workspaces/workspaceUiState";
import { fakeLocalStateOpens } from "../testing/preparedLocalState";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import { RendererWorkspaceSessionOwner, type RendererWorkspaceSession } from "../window/rendererWorkspaceSessionOwner";
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace } from "../workspaces/workspaceAuthorityOwner";
import type { RegistryEntry } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import { settingsWithAgent, testAgent } from "../testing/agentSettings";
import { deferred } from "../testing/deferred";

const DOCUMENT = "123e4567-e89b-42d3-a456-426614174001";
const state = WorkspaceUiState.parse({
  version: 3, activeView: "explorer", sidebarVisible: true, sidebarWidth: 320,
  editorGroups: [{ id: "main", tabs: [], activeTab: null, size: 1 }], activeEditorGroup: "main",
});
const settingsPayload = { settings: DEFAULT_USER_SETTINGS, base: DEFAULT_USER_SETTINGS };
const workspacePayload = { workspaceId: "workspace-a" };
const patchPayload = { ...workspacePayload, patch: { privacy: { confirmExternalLinks: false } } };
const uiPayload = { ...workspacePayload, state };
const localState = fakeLocalStateOpens();
const settingsRequests = [
  [settingsOperations.getUserSettings.channel, undefined],
  [settingsOperations.reloadUserSettings.channel, undefined],
  [settingsOperations.setUserSettings.channel, settingsPayload],
  [settingsOperations.setAppPinned.channel, { workspaceId: "workspace-a", appRoot: "apps/trip", pinned: true }],
  [settingsOperations.setAgentColor.channel, { workspaceId: "workspace-a", group: "unknown", hue: null }],
  [settingsOperations.resetUserSettings.channel, undefined],
  [settingsOperations.getUserSettingsFilePath.channel, undefined],
  [settingsOperations.openUserSettingsFile.channel, undefined],
  [settingsOperations.openWorkspaceSettingsFile.channel, workspacePayload],
  [settingsOperations.getWorkspaceSettings.channel, workspacePayload],
  [settingsOperations.setWorkspaceSettings.channel, patchPayload],
  [settingsOperations.resetWorkspaceSettings.channel, workspacePayload],
] as const;
const workspaceRequests = [
  [settingsOperations.getWorkspaceSettings.channel, workspacePayload],
  [settingsOperations.setWorkspaceSettings.channel, patchPayload],
  [settingsOperations.resetWorkspaceSettings.channel, workspacePayload],
  [settingsOperations.getWorkspaceUiState.channel, workspacePayload],
  [settingsOperations.setWorkspaceUiState.channel, uiPayload],
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
  const applyThemeMode = vi.fn((value: ThemeMode) => { effects.push({ kind: "theme", value, persisted: persisted() }); });
  const setSpellCheckerEnabled = vi.fn<(enabled: boolean) => void>();
  const broadcastUserSettings = vi.fn();
  const broadcastAgentColor = vi.fn();
  const notifyRenderer = vi.fn();
  const refreshDispatchTray = vi.fn<() => Promise<unknown>>(async () => undefined);
  const openDispatchWorkspaces = vi.fn(() => [...entries.values()]);
  const scanWorkspace = vi.fn<(workspaceId: string) => Promise<unknown>>(async () => undefined);
  const openPath = vi.fn<(path: string) => Promise<string>>(async () => "");
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const capability = createSettingsIpc<Sender, Event, Operation>({
    stateDir: () => stateDirectory, setCachedPreferredName,
    applyZoomLevelToWindows, applyThemeMode, setSpellCheckerEnabled, refreshDispatchTray, openDispatchWorkspaces,
    chatDispatchService: { scanWorkspace }, withRendererWorkspaceOperation,
    broadcastUserSettings, broadcastAgentColor, notifyRenderer, openPath,
    knownWorkspaceIds: () => [...entries.keys()],
  });
  registerOperations<typeof settingsOperations, Event, Operation>({
    handle: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    assertTrustedSender: event => { if (!event.trusted) throw new Error("untrusted"); },
    withActiveWorkspace: (event, id, message, work) => withRendererWorkspaceOperation(event.sender, id, message, work),
  }, settingsOperations, capability);
  dispose.push(async () => {
    await Promise.all([sessions.retireAfterCrash(first), sessions.retireAfterCrash(second)]);
    await authorities.close();
  });
  return {
    handlers, effects, entries, authorities, sessions, first, second, open,
    zoom: capability.stepWindowZoom, setCachedPreferredName, applyZoomLevelToWindows, applyThemeMode, setSpellCheckerEnabled,
    refreshDispatchTray, openDispatchWorkspaces, scanWorkspace, broadcastUserSettings, broadcastAgentColor, notifyRenderer,
    openPath, reload: capability.reloadUserSettings,
    preferredName: () => preferredName, stateDirectory: () => stateDirectory,
    setStateDirectory: (value: string) => { stateDirectory = value; },
    root: entries.get("workspace-a")!.rootPath, otherRoot: entries.get("workspace-b")!.rootPath,
    // What workspace-a's engine open does: prepare .dohc/local, then answer.
    prepareLocalState: async (ready = true, workspaceId = "workspace-a") => {
      const workspace = entries.get(workspaceId)!;
      await localState.open(workspace, ready);
      return workspace;
    },
    closeLocalState: () => localState.close(entries.get("workspace-a")!),
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
  it("registers all settings operations", async () => {
    const h = await harness();
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
    for (const channel of [settingsOperations.setUserSettings.channel, ...workspaceRequests.map(([channel]) => channel)]) {
      await expect(h.invoke(channel, {})).rejects.toThrow();
    }
    await expect(h.invoke(settingsOperations.setUserSettings.channel, { settings: settingsWithAgent({ launch: { command: " " } }), base: DEFAULT_USER_SETTINGS })).rejects.toThrow();
    await expect(h.invoke(settingsOperations.setWorkspaceUiState.channel, { ...uiPayload, state: { ...state, sidebarWidth: -1 } })).rejects.toThrow();
    for (const port of [writes, workspaceReads, workspaceWrites, resets, uiReads, uiWrites]) expect(port).not.toHaveBeenCalled();
    expect(h.effects).toEqual([]);
  });

  it("reads defaults, refreshes cached reads after save, and resets the persisted user settings", async () => {
    const h = await harness();
    await expect(h.invoke(settingsOperations.getUserSettings.channel)).resolves.toEqual({ settings: DEFAULT_USER_SETTINGS, source: "default" });
    const settings = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Sam" }, appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 2 } };
    await expect(h.invoke(settingsOperations.setUserSettings.channel, { settings, base: DEFAULT_USER_SETTINGS })).resolves.toEqual({ settings, source: "stored" });
    expect(h.preferredName()).toBe("Sam");
    await expect(h.invoke(settingsOperations.getUserSettings.channel)).resolves.toEqual({ settings, source: "stored" });
    await expect(h.invoke(settingsOperations.resetUserSettings.channel)).resolves.toEqual({ settings: DEFAULT_USER_SETTINGS, source: "stored" });
    expect(h.broadcastUserSettings).toHaveBeenLastCalledWith({ settings: DEFAULT_USER_SETTINGS, source: "stored" });
    expect(h.preferredName()).toBeUndefined();
    expect(h.effects.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: "name", value: "Sam" }, { kind: "zoom", value: 2 }, { kind: "theme", value: "system" },
      { kind: "name", value: undefined }, { kind: "zoom", value: 0 }, { kind: "theme", value: "system" },
    ]);
    for (const effect of h.effects) {
      expect(effect.value).toEqual(effect.kind === "name" ? effect.persisted.profile.preferredName
        : effect.kind === "zoom" ? effect.persisted.appearance.zoomLevel : effect.persisted.appearance.themeMode);
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
    const firstSettings = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "First" }, appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 1, themeMode: "dark" as const } };
    const nextSettings = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Next" }, appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: -2, themeMode: "light" as const } };
    const first = h.invoke(settingsOperations.setUserSettings.channel, { settings: firstSettings, base: DEFAULT_USER_SETTINGS });
    const pending = [first];
    try {
      await reached.promise;
      const next = h.invoke(settingsOperations.setUserSettings.channel, { settings: nextSettings, base: DEFAULT_USER_SETTINGS });
      const zoom = h.zoom("in");
      const reset = h.invoke(settingsOperations.resetUserSettings.channel);
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
      expect(h.setCachedPreferredName.mock.calls).toEqual([["First", []], ["Next", []], ["Next", []], [undefined, []]]);
      expect(h.applyZoomLevelToWindows.mock.calls).toEqual([[1], [-2], [-1], [0]]);
      expect(h.applyThemeMode.mock.calls).toEqual([["dark"], ["light"], ["light"], ["system"]]);
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
    await expect(h.invoke(settingsOperations.setUserSettings.channel, { settings: named, base: DEFAULT_USER_SETTINGS })).rejects.toThrow();
    expect(h.preferredName()).toBe("Before");
    expect(h.effects).toEqual([]);
    expect(h.refreshDispatchTray).not.toHaveBeenCalled();
    expect(h.scanWorkspace).not.toHaveBeenCalled();
    expect(await readFile(blocked, "utf8")).toBe("keep");
    h.setStateDirectory(directory);
    await expect(h.invoke(settingsOperations.resetUserSettings.channel)).resolves.toEqual({ settings: DEFAULT_USER_SETTINGS, source: "stored" });
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
    const saving = h.invoke(settingsOperations.setUserSettings.channel, { settings: named, base: DEFAULT_USER_SETTINGS });
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
    const settings = settingsWithAgent({ name: "Nova", launch: { command: "agent run" } });
    const result = h.invoke(settingsOperations.setUserSettings.channel, { settings, base: DEFAULT_USER_SETTINGS });
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
    const settings = settingsWithAgent({ name: "Nova", launch: { command: "agent run" } });
    await expect(h.invoke(settingsOperations.setUserSettings.channel, { settings, base: DEFAULT_USER_SETTINGS })).rejects.toBe(error);
    await expect(userSettingsStore.readUserSettingsFile(h.stateDirectory())).resolves.toEqual({ settings, source: "stored" });
    expect(h.effects).toHaveLength(3);
    expect(h.scanWorkspace).not.toHaveBeenCalled();
  });

  it("scans when any agent dohc starts changes, not only the first", async () => {
    const h = await harness();
    const one = settingsWithAgent({ name: "Nova", launch: { command: "agent run" } });
    await h.invoke(settingsOperations.setUserSettings.channel, { settings: one, base: DEFAULT_USER_SETTINGS });
    await vi.waitFor(() => expect(h.scanWorkspace).toHaveBeenCalledTimes(2));
    h.scanWorkspace.mockClear();
    const off = { ...one, agents: { ...one.agents, codex: testAgent({ name: "Codex", enabled: false }) } };
    await h.invoke(settingsOperations.setUserSettings.channel, { settings: off, base: one });
    // An agent that is off does not change what dohc starts.
    expect(h.scanWorkspace).not.toHaveBeenCalled();
    const on = { ...off, agents: { ...off.agents, codex: testAgent({ name: "Codex" }) } };
    await h.invoke(settingsOperations.setUserSettings.channel, { settings: on, base: off });
    await vi.waitFor(() => expect(h.scanWorkspace.mock.calls).toEqual([["workspace-a"], ["workspace-b"]]));
  });

  it("applies a hand edit of the settings file as a save does, and finds nothing new after dohc's own save", async () => {
    const h = await harness();
    const path = join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE);
    await h.invoke(settingsOperations.setUserSettings.channel, { settings: { ...DEFAULT_USER_SETTINGS, appearance: { ...DEFAULT_USER_SETTINGS.appearance, zoomLevel: 1 } }, base: DEFAULT_USER_SETTINGS });
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
      settings: { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Ada" }, appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark", zoomLevel: 3 } },
      source: "stored",
      ignored: [{ key: "fancyBorders", reason: "unknown" }],
    };
    expect(h.broadcastUserSettings).toHaveBeenCalledExactlyOnceWith(applied);
    expect(h.applyZoomLevelToWindows).toHaveBeenCalledExactlyOnceWith(3);
    expect(h.preferredName()).toBe("Ada");
    expect(h.refreshDispatchTray).toHaveBeenCalledOnce();
    await expect(h.invoke(settingsOperations.getUserSettings.channel)).resolves.toEqual(applied);
  });

  it("turns spellcheck on and off with the setting, from Settings or a hand edit", async () => {
    const h = await harness();
    const path = join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE);
    const off = { ...DEFAULT_USER_SETTINGS, editor: { ...DEFAULT_USER_SETTINGS.editor, spellcheck: false } };
    await h.invoke(settingsOperations.setUserSettings.channel, { settings: off, base: DEFAULT_USER_SETTINGS });
    expect(h.setSpellCheckerEnabled).toHaveBeenLastCalledWith(false);
    await writeFile(path, JSON.stringify({ editor: { spellcheck: true } }));
    await h.reload();
    expect(h.setSpellCheckerEnabled).toHaveBeenLastCalledWith(true);
  });

  it("steps zoom from the file as it is now and puts a hand edit it merged into effect", async () => {
    const h = await harness();
    const path = join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE);
    const dark = { ...DEFAULT_USER_SETTINGS, appearance: { ...DEFAULT_USER_SETTINGS.appearance, themeMode: "dark" as const } };
    await h.invoke(settingsOperations.setUserSettings.channel, { settings: dark, base: DEFAULT_USER_SETTINGS });
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
      version: 2,
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

  it("scans for waiting runner work only when the agent that answers changes", async () => {
    const h = await harness();
    const runner = settingsWithAgent({ name: "Nova", launch: { command: "agent run" } });
    await h.invoke(settingsOperations.setUserSettings.channel, { settings: runner, base: DEFAULT_USER_SETTINGS });
    await vi.waitFor(() => expect(h.scanWorkspace).toHaveBeenCalledTimes(2));
    h.scanWorkspace.mockClear();
    await h.zoom("in");
    await h.invoke(settingsOperations.setUserSettings.channel, {
      settings: { ...runner, profile: { ...runner.profile, preferredName: "Sam" } },
      base: runner,
    });
    expect(h.scanWorkspace).not.toHaveBeenCalled();
    expect(h.refreshDispatchTray).toHaveBeenCalledTimes(3);
  });

  it("applies two quick pins to the file one after the other, so both land", async () => {
    const h = await harness();
    const [first, second] = await Promise.all([
      h.invoke(settingsOperations.setAppPinned.channel, { workspaceId: "workspace-a", appRoot: "apps/trip", pinned: true }),
      h.invoke(settingsOperations.setAppPinned.channel, { workspaceId: "workspace-a", appRoot: "budget", pinned: true }),
    ]);
    expect(first).toMatchObject({ settings: { sidebar: { pinnedApps: { "workspace-a": ["apps/trip"] } } } });
    expect(second).toMatchObject({ settings: { sidebar: { pinnedApps: { "workspace-a": ["apps/trip", "budget"] } } } });
    await h.invoke(settingsOperations.setAppPinned.channel, { workspaceId: "workspace-a", appRoot: "apps/trip", pinned: false });
    await expect(userSettingsStore.readUserSettingsFile(h.stateDirectory())).resolves.toMatchObject({
      settings: { sidebar: { pinnedApps: { "workspace-a": ["budget"] } } },
    });
    expect(h.broadcastUserSettings).toHaveBeenCalledTimes(3);
  });

  it("opens this workspace's settings file through the workspace that asked", async () => {
    const h = await harness();
    await workspaceSettingsFile.saveWorkspaceSettingsFile(await h.prepareLocalState(), { privacy: { confirmExternalLinks: false } });
    await h.invoke(settingsOperations.openWorkspaceSettingsFile.channel, workspacePayload);
    expect(h.openPath).toHaveBeenCalledExactlyOnceWith(join(h.root, ".dohc", "local", workspaceSettingsFile.WORKSPACE_SETTINGS_FILE));
    await expect(h.invoke(settingsOperations.openWorkspaceSettingsFile.channel, workspacePayload, h.second)).rejects.toThrow("this window changed workspaces");
    expect(h.openPath).toHaveBeenCalledOnce();
  });

  it("creates the settings file before opening it, and never replaces one that exists", async () => {
    const h = await harness();
    const path = join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE);
    await expect(h.invoke(settingsOperations.getUserSettingsFilePath.channel)).resolves.toBe(path);
    await h.invoke(settingsOperations.openUserSettingsFile.channel);
    expect(h.openPath).toHaveBeenCalledExactlyOnceWith(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(DEFAULT_USER_SETTINGS);
    await h.reload();
    expect(h.broadcastUserSettings).not.toHaveBeenCalled();

    await writeFile(path, "{ \"appearance\": ");
    await h.invoke(settingsOperations.openUserSettingsFile.channel);
    expect(await readFile(path, "utf8")).toBe("{ \"appearance\": ");
    h.openPath.mockResolvedValueOnce("No application is associated with this file.");
    await expect(h.invoke(settingsOperations.openUserSettingsFile.channel)).rejects.toThrow(
      `dohc could not open ${path}. No application is associated with this file. Open the file in a text editor.`,
    );
  });
});

describe("registered workspace settings and UI state", () => {
  it.each([
    ["getWorkspaceSettings", workspacePayload, "Workspace settings read stopped because this window changed workspaces."],
    ["setWorkspaceSettings", patchPayload, "Workspace settings save stopped because this window changed workspaces."],
    ["resetWorkspaceSettings", workspacePayload, "Workspace settings reset stopped because this window changed workspaces."],
    ["getWorkspaceUiState", workspacePayload, "UI state read stopped because this window changed workspaces."],
    ["setWorkspaceUiState", uiPayload, "UI state write stopped because this window changed workspaces."],
  ] as const)("the %s row keeps its exact foreign-workspace refusal", async (name, payload, message) => {
    const row = Object.assign({}, ...OPERATION_TABLES)[name];
    expect(row).toMatchObject({ scope: "workspace", guard: "active-workspace", inactiveMessage: message });
    const h = await harness();
    await expect(h.invoke(row.channel, payload, h.second)).rejects.toThrow(new Error(message));
  });

  it.each([false, true])("the settings opener row suppresses a path resolved after a workspace switch (reopen=%s)", async reopen => {
    const row = Object.assign({}, ...OPERATION_TABLES).openWorkspaceSettingsFile;
    expect(row).toMatchObject({ scope: "workspace", guard: "trusted-sender" });
    const h = await harness();
    const reached = deferred(), release = deferred();
    const realPath = workspaceSettingsFile.workspaceSettingsPath;
    vi.spyOn(workspaceSettingsFile, "workspaceSettingsPath").mockImplementationOnce(async root => {
      const path = await realPath(root);
      reached.resolve(); await release.promise; return path;
    });
    const result = h.invoke(row.channel, workspacePayload);
    const rejection = expect(result).rejects.toThrow("Workspace settings stopped opening because this window changed workspaces.");
    try {
      await reached.promise;
      await h.open(h.first, "workspace-b");
      if (reopen) await h.open(h.first, "workspace-a");
    } finally {
      release.resolve();
      await rejection;
    }
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it("the settings opener row releases the workspace operation before waiting for the system editor", async () => {
    const row = Object.assign({}, ...OPERATION_TABLES).openWorkspaceSettingsFile;
    expect(row).toMatchObject({ scope: "workspace", guard: "trusted-sender" });
    const h = await harness();
    const reached = deferred(), release = deferred();
    h.openPath.mockImplementationOnce(async () => { reached.resolve(); await release.promise; return ""; });
    const result = h.invoke(row.channel, workspacePayload);
    try {
      await reached.promise;
      await h.open(h.first, "workspace-b");
      release.resolve();
      await expect(result).resolves.toBeUndefined();
    } finally {
      release.resolve();
      await Promise.allSettled([result]);
    }
  });

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
    await expect(h.invoke(settingsOperations.getWorkspaceSettings.channel, workspacePayload)).resolves.toEqual({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" });
    await workspaceSettingsFile.saveWorkspaceSettingsFile(await h.prepareLocalState(), { sites: { defaultPreviewMode: "static" } });
    await workspaceSettingsFile.saveWorkspaceSettingsFile(await h.prepareLocalState(true, "workspace-b"), { sites: { defaultPreviewMode: "build" } });
    const saved = await h.invoke(settingsOperations.setWorkspaceSettings.channel, patchPayload);
    expect(saved).toMatchObject({ settings: { privacy: { confirmExternalLinks: false }, sites: { defaultPreviewMode: "static" } }, source: "stored" });
    await expect(h.invoke(settingsOperations.getWorkspaceSettings.channel, workspacePayload)).resolves.toEqual(saved);
    await expect(h.invoke(settingsOperations.resetWorkspaceSettings.channel, workspacePayload)).resolves.toEqual({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "stored" });
    await expect(workspaceSettingsFile.readWorkspaceSettingsFile(h.entries.get("workspace-b")!)).resolves.toMatchObject({ settings: { sites: { defaultPreviewMode: "build" } } });
  });

  it("keeps recovery warnings and save refusals from the real settings file owner", async () => {
    const h = await harness();
    await h.prepareLocalState();
    const path = join(h.root, ".dohc", "local", workspaceSettingsFile.WORKSPACE_SETTINGS_FILE);
    await writeFile(path, "{broken");
    const read = await h.invoke(settingsOperations.getWorkspaceSettings.channel, workspacePayload);
    expect(read).toMatchObject({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "recovered", warning: expect.stringContaining(path) });
    await expect(h.invoke(settingsOperations.setWorkspaceSettings.channel, patchPayload)).resolves.toMatchObject({ source: "recovered", refusal: expect.stringContaining(path) });
    expect(await readFile(path, "utf8")).toBe("{broken");
    await expect(h.invoke(settingsOperations.resetWorkspaceSettings.channel, workspacePayload)).resolves.toEqual({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "stored" });
  });

  it("refuses a workspace settings save or reset until .dohc/local is ready, with words, and makes nothing", async () => {
    const h = await harness();
    // The window is admitted, but this workspace's engine open has not answered.
    await expect(h.invoke(settingsOperations.getWorkspaceSettings.channel, workspacePayload))
      .resolves.toEqual({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" });
    await expect(h.invoke(settingsOperations.setWorkspaceSettings.channel, patchPayload)).rejects.toThrow(
      "dohc did not save this workspace's settings because the workspace has not finished opening. Try again when it opens.",
    );
    await expect(h.invoke(settingsOperations.resetWorkspaceSettings.channel, workspacePayload)).rejects.toThrow(
      "dohc did not reset this workspace's settings because the workspace has not finished opening. Try again when it opens.",
    );
    expect(await lstat(join(h.root, ".dohc")).catch(() => null)).toBeNull();

    await h.prepareLocalState(false);
    await expect(h.invoke(settingsOperations.setWorkspaceSettings.channel, patchPayload)).rejects.toThrow(
      "dohc did not save this workspace's settings because it can't keep this computer's settings out of iCloud Drive. Restart dohc to try again.",
    );
    expect(await readdir(join(h.root, ".dohc", "local"))).toEqual([]);

    await h.prepareLocalState();
    await expect(h.invoke(settingsOperations.setWorkspaceSettings.channel, patchPayload))
      .resolves.toMatchObject({ settings: { privacy: { confirmExternalLinks: false } }, source: "stored" });
  });

  it.each(["renderer", "physical"])("suppresses a held workspace settings read after %s retirement", async owner => {
    const h = await harness();
    const reached = deferred(), release = deferred();
    const realRead = workspaceSettingsFile.readWorkspaceSettingsFile;
    vi.spyOn(workspaceSettingsFile, "readWorkspaceSettingsFile").mockImplementationOnce(async workspace => {
      const result = await realRead(workspace); reached.resolve(); await release.promise; return result;
    });
    const result = h.invoke(settingsOperations.getWorkspaceSettings.channel, workspacePayload);
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
    await h.prepareLocalState();
    const reached = deferred(), release = deferred();
    const realSave = workspaceSettingsFile.saveWorkspaceSettingsFile;
    vi.spyOn(workspaceSettingsFile, "saveWorkspaceSettingsFile").mockImplementationOnce(async (workspace, patch) => {
      const result = await realSave(workspace, patch); reached.resolve(); await release.promise; return result;
    });
    const result = h.invoke(settingsOperations.setWorkspaceSettings.channel, patchPayload);
    const rejection = expect(result).rejects.toThrow("this window changed workspaces");
    try {
      await reached.promise;
      await h.open(h.first, "workspace-b");
    } finally {
      release.resolve();
      await rejection;
    }
    await expect(workspaceSettingsFile.readWorkspaceSettingsFile(h.entries.get("workspace-a")!)).resolves.toMatchObject({ settings: { privacy: { confirmExternalLinks: false } } });
  });

  it("round-trips parsed UI state through the admitted workspace and strips unknown write fields", async () => {
    const h = await harness();
    await h.prepareLocalState();
    await expect(h.invoke(settingsOperations.getWorkspaceUiState.channel, workspacePayload)).resolves.toBeNull();
    await expect(h.invoke(settingsOperations.setWorkspaceUiState.channel, { ...uiPayload, state: { ...state, extra: "discard" } })).resolves.toBeUndefined();
    await expect(h.invoke(settingsOperations.getWorkspaceUiState.channel, workspacePayload)).resolves.toEqual(state);
    await expect(uiStateStore.readUiStateFile(h.otherRoot)).resolves.toBeNull();
  });

  it("refuses a UI-state write the engine has not prepared .dohc/local for, and makes nothing", async () => {
    const h = await harness();
    // The renderer is admitted, but this workspace's engine open has not answered.
    await expect(h.invoke(settingsOperations.setWorkspaceUiState.channel, uiPayload)).rejects.toThrow(
      "dohc has not finished opening this workspace. Try again when it opens.",
    );
    expect(await lstat(join(h.root, ".dohc")).catch(() => null)).toBeNull();
    await expect(h.invoke(settingsOperations.getWorkspaceUiState.channel, workspacePayload)).resolves.toBeNull();

    // The open could not keep the folder out of iCloud Drive.
    await h.prepareLocalState(false);
    await expect(h.invoke(settingsOperations.setWorkspaceUiState.channel, uiPayload)).rejects.toThrow("out of iCloud Drive");
    expect(await readdir(join(h.root, ".dohc", "local"))).toEqual([]);

    await h.prepareLocalState();
    await expect(h.invoke(settingsOperations.setWorkspaceUiState.channel, uiPayload)).resolves.toBeUndefined();
    await expect(h.invoke(settingsOperations.getWorkspaceUiState.channel, workspacePayload)).resolves.toEqual(state);

    // Once the engine closes the workspace, writes stop and the saved layout stays.
    h.closeLocalState();
    await expect(h.invoke(settingsOperations.setWorkspaceUiState.channel, { ...uiPayload, state: { ...state, sidebarWidth: 300 } }))
      .rejects.toThrow("dohc has not finished opening this workspace.");
    // On Windows nothing reads it until the next open holds the folder.
    expect(JSON.parse(await readFile(join(h.root, ".dohc", "local", "ui-state.json"), "utf8"))).toEqual(state);
  });

  it("denies a UI-state read from a renderer until its open admits it", async () => {
    const h = await harness();
    const fresh = sender(3);
    dispose.unshift(() => h.sessions.retireAfterCrash(fresh));
    await uiStateStore.writeUiStateFile(await h.prepareLocalState(), state);
    const uiReads = vi.spyOn(uiStateStore, "readUiStateFile");
    await expect(h.invoke(settingsOperations.getWorkspaceUiState.channel, workspacePayload, fresh)).rejects.toThrow("UI state read stopped because this window changed workspaces.");
    expect(uiReads).not.toHaveBeenCalled();
    await h.open(fresh, "workspace-a");
    await expect(h.invoke(settingsOperations.getWorkspaceUiState.channel, workspacePayload, fresh)).resolves.toEqual(state);
  });

  it.each(["null", "[]", "7", "\"text\"", "{broken"])("returns null for unavailable or non-object UI state: %s", async raw => {
    const h = await harness();
    await h.prepareLocalState();
    await writeFile(join(h.root, ".dohc", "local", "ui-state.json"), raw);
    await expect(h.invoke(settingsOperations.getWorkspaceUiState.channel, workspacePayload)).resolves.toBeNull();
  });

  it("preserves raw object fields for renderer repair on UI-state reads", async () => {
    const h = await harness();
    const raw = { version: 1, activeView: "foreign", sidebarWidth: -100, extra: { retained: true } };
    await uiStateStore.writeUiStateFile(await h.prepareLocalState(), raw);
    await expect(h.invoke(settingsOperations.getWorkspaceUiState.channel, workspacePayload)).resolves.toEqual(raw);
  });

  it.each(["read", "write"])("suppresses UI-state %s completion after renderer retirement", async kind => {
    const h = await harness();
    await uiStateStore.writeUiStateFile(await h.prepareLocalState(), state);
    const reached = deferred(), release = deferred();
    const realRead = uiStateStore.readUiStateFile, realWrite = uiStateStore.writeUiStateFile;
    if (kind === "read") vi.spyOn(uiStateStore, "readUiStateFile").mockImplementationOnce(async root => {
      const result = await realRead(root); reached.resolve(); await release.promise; return result;
    });
    else vi.spyOn(uiStateStore, "writeUiStateFile").mockImplementationOnce(async (workspace, value) => {
      await realWrite(workspace, value); reached.resolve(); await release.promise;
    });
    const result = h.invoke(kind === "read" ? settingsOperations.getWorkspaceUiState.channel : settingsOperations.setWorkspaceUiState.channel, kind === "read" ? workspacePayload : uiPayload);
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


function agentTokens(workspaceId: string) {
  return createHistoryPresentationRequest({ source: "own-store", workspaceId, assertCurrent: () => undefined,
    installationId: "device", credentials: null, serverUrl: undefined, synced: false })([
    { kind: "agent", agentId: "bot", onBehalfOf: "device" }, { kind: "human", humanId: "device" },
  ]);
}
describe("personal agent colour IPC", () => {
  it("rejects unknown, human, foreign-workspace and inactive groups without saving", async () => {
    const h = await harness();
    const [agent, human] = agentTokens("workspace-a");
    const [foreign] = agentTokens("workspace-b");
    for (const group of ["unknown", human!.group, foreign!.group]) {
      await expect(h.invoke(settingsOperations.setAgentColor.channel, { workspaceId: "workspace-a", group, hue: "blue" })).rejects.toThrow();
    }
    await expect(h.invoke(settingsOperations.setAgentColor.channel,
      { workspaceId: "workspace-a", group: agent!.group, hue: "blue" }, h.second)).rejects.toThrow();
    expect(h.broadcastAgentColor).not.toHaveBeenCalled();
    expect((await userSettingsStore.readUserSettingsFile(h.stateDirectory())).source).toBe("default");
  });
  it("persists locally, omits keys from every settings result, preserves renderer saves, and clears with null or reset", async () => {
    const h = await harness();
    const [agent] = agentTokens("workspace-a");
    const [other] = agentTokens("workspace-b");
    const change = { workspaceId: "workspace-a", group: agent!.group, hue: "blue" } as const;
    await h.invoke(settingsOperations.setAgentColor.channel, change);
    expect(h.broadcastAgentColor.mock.calls.map(([event]) => event)).toEqual([
      change, { ...change, workspaceId: "workspace-b", group: other!.group },
    ]);
    expect(h.broadcastUserSettings).toHaveBeenCalledWith(expect.objectContaining({ source: "stored" }));
    const stored = await userSettingsStore.readUserSettingsFile(h.stateDirectory());
    expect(Object.values(stored.settings.appearance.agentColors ?? {})).toEqual(["blue"]);
    for (const channel of [settingsOperations.getUserSettings.channel, settingsOperations.reloadUserSettings.channel]) {
      const result = await h.invoke(channel);
      expect(JSON.stringify(result)).not.toContain("agentColors");
    }
    const settings = { ...DEFAULT_USER_SETTINGS, editor: { ...DEFAULT_USER_SETTINGS.editor, fontSize: 16 } };
    const saved = await h.invoke(settingsOperations.setUserSettings.channel, { settings, base: DEFAULT_USER_SETTINGS });
    expect(JSON.stringify(saved)).not.toContain("agentColors");
    expect((await userSettingsStore.readUserSettingsFile(h.stateDirectory())).settings.appearance.agentColors).toEqual(stored.settings.appearance.agentColors);
    for (const [result] of h.broadcastUserSettings.mock.calls) expect(JSON.stringify(result)).not.toContain("agentColors");
    expect(h.scanWorkspace).not.toHaveBeenCalled();
    await h.invoke(settingsOperations.setAgentColor.channel, { ...change, hue: null });
    expect((await userSettingsStore.readUserSettingsFile(h.stateDirectory())).settings.appearance.agentColors).toEqual({});
    expect(h.broadcastAgentColor).toHaveBeenCalledWith({ ...change, hue: null });
    await h.invoke(settingsOperations.setAgentColor.channel, change);
    await h.invoke(settingsOperations.resetUserSettings.channel);
    expect((await userSettingsStore.readUserSettingsFile(h.stateDirectory())).settings.appearance.agentColors).toBeUndefined();
    expect(h.broadcastAgentColor).toHaveBeenLastCalledWith({ ...change, workspaceId: "workspace-b", group: other!.group, hue: null });
  });
  it("never discloses rejected stored keys through ignored-setting paths", async () => {
    const h = await harness();
    await writeFile(join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE), JSON.stringify({ ...DEFAULT_USER_SETTINGS,
      appearance: { ...DEFAULT_USER_SETTINGS.appearance, agentColors: { "private-account-and-server": "olive" } } }));
    const result = await h.reload();
    expect(JSON.stringify(result)).not.toContain("private-account-and-server");
    expect(JSON.stringify(h.broadcastUserSettings.mock.calls)).not.toContain("private-account-and-server");
  });
});

it("skips repeated colour selections and clearing an unset colour", async () => {
  const h = await harness();
  const [agent] = agentTokens("workspace-a");
  const change = { workspaceId: "workspace-a", group: agent!.group, hue: "blue" } as const;
  await h.invoke(settingsOperations.setAgentColor.channel, { ...change, hue: null });
  expect((await userSettingsStore.readUserSettingsFile(h.stateDirectory())).source).toBe("default");
  expect(h.effects).toHaveLength(0);
  expect(h.broadcastUserSettings).not.toHaveBeenCalled();
  expect(h.refreshDispatchTray).not.toHaveBeenCalled();
  await h.invoke(settingsOperations.setAgentColor.channel, change);
  h.broadcastUserSettings.mockClear();
  h.broadcastAgentColor.mockClear();
  h.refreshDispatchTray.mockClear();
  const effects = h.effects.length;
  await h.invoke(settingsOperations.setAgentColor.channel, change);
  expect(h.effects).toHaveLength(effects);
  expect(h.broadcastUserSettings).not.toHaveBeenCalled();
  expect(h.broadcastAgentColor).not.toHaveBeenCalled();
  expect(h.refreshDispatchTray).not.toHaveBeenCalled();
});

it("broadcasts changed notices alongside a private colour edit", async () => {
  const h = await harness();
  await h.invoke(settingsOperations.setUserSettings.channel, settingsPayload);
  h.broadcastUserSettings.mockClear();
  await writeFile(join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE), JSON.stringify({
    ...DEFAULT_USER_SETTINGS, unknownSetting: true,
    appearance: { ...DEFAULT_USER_SETTINGS.appearance, agentColors: { private: "blue" } },
  }));
  await h.reload();
  expect(h.broadcastUserSettings).toHaveBeenLastCalledWith(expect.objectContaining({
    ignored: [{ key: "unknownSetting", reason: "unknown" }],
  }));
  h.broadcastUserSettings.mockClear();
  await writeFile(join(h.stateDirectory(), userSettingsStore.USER_SETTINGS_FILE), JSON.stringify({
    ...DEFAULT_USER_SETTINGS, appearance: { ...DEFAULT_USER_SETTINGS.appearance, agentColors: { private: "rose" } },
  }));
  await h.reload();
  expect(h.broadcastUserSettings).toHaveBeenLastCalledWith(expect.objectContaining({ ignored: undefined }));
});
