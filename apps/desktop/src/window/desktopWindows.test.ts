import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions, WebContents, KeyboardEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopWindows } from "./desktopWindows";
import { RendererWorkspaceSessionOwner } from "./rendererWorkspaceSessionOwner";
import { CHANNELS } from "../ipc/channels";
import type { WorkspaceSummary } from "../ipc/bridgeContract";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettingsResult } from "../settings/userSettings";
import { deferred } from "../testing/deferred";
import * as windowZoom from "./windowZoom";
import { createWorkspaceRootApproval, registerWorkspaceRegistryIpcHandlers } from "../ipc/workspaceRegistryIpc";
import { createWorkspaceFolder } from "../workspaces/createWorkspaceFolder";
import { createRegistryStore } from "../workspaces/registryStore";
import { workspaceSummariesFrom } from "../workspaces/workspaceSummaryProjection";
import { createTestScratch } from "../workspaces/testTemp";

let nextSender = 1;
class Contents extends EventEmitter {
  readonly id = nextSender++;
  destroyed = false;
  setZoomLevel = vi.fn();
  send = vi.fn();
  isDestroyed() { return this.destroyed; }
  get native(): WebContents { return this as unknown as WebContents; }
}

class Window extends EventEmitter {
  readonly webContents = new Contents();
  destroyed = false;
  minimized = false;
  show = vi.fn(); focus = vi.fn(); restore = vi.fn();
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  get native(): BrowserWindow { return this as unknown as BrowserWindow; }
  finishLoad() { this.webContents.emit("did-finish-load"); }
  failLoad(isMainFrame = true) {
    this.webContents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "app://renderer", isMainFrame);
  }
}

type Dependencies = Parameters<typeof createDesktopWindows>[0];
const workspace = (workspaceId: string, rootPath = `C:\\work\\${workspaceId}`): WorkspaceSummary => ({
  workspaceId, rootPath, kind: "personal", mode: "local-first",
});
const settings = (zoomLevel = 0): DesktopUserSettingsResult => ({
  settings: { ...structuredClone(DEFAULT_USER_SETTINGS), appearance: {
    ...DEFAULT_USER_SETTINGS.appearance, zoomLevel,
  } }, source: "stored",
});

function fixture(platform: NodeJS.Platform = "win32", workspaceSummaries?: Dependencies["workspaceSummaries"]) {
  let stored = settings();
  let read: Dependencies["readCachedUserSettingsFile"] = async () => structuredClone(stored);
  let ready = true;
  let canInstall = false;
  let rows = [workspace("a"), workspace("b")];
  let retirement: () => Promise<void> = async () => undefined;
  const sessions = new RendererWorkspaceSessionOwner<WebContents>({
    retirement: {
      retireSender: () => ({ requiredForAdmission: retirement(), detachedFromAdmission: Promise.resolve() }),
      retireWorkspace: async () => undefined,
    },
  });
  let currentSessions = sessions;
  const all: Window[] = [];
  const createdOptions: Array<Parameters<Dependencies["createMainWindow"]>[0]> = [];
  const templates: MenuItemConstructorOptions[][] = [];
  const dependencies: Dependencies = {
    app: {
      isReady: () => ready, isPackaged: false, getVersion: () => "1.2.3",
      clearRecentDocuments: vi.fn(), addRecentDocument: vi.fn(), setUserTasks: vi.fn(() => true),
    },
    BrowserWindow: { getAllWindows: () => all.map((item) => item.native) },
    Menu: {
      buildFromTemplate: vi.fn((template) => { templates.push(template); return { template } as unknown as Menu; }),
      setApplicationMenu: vi.fn(),
    },
    dialog: {
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    },
    process: { platform, execPath: "C:\\dohc\\dohc.exe" },
    workspaceSummaries: workspaceSummaries ?? vi.fn(() => rows),
    currentUpdateState: vi.fn(() => ({ canInstall })),
    stateDir: () => "state",
    readCachedUserSettingsFile: vi.fn((directory) => read(directory)),
    stepWindowZoom: vi.fn(async () => structuredClone(stored)),
    createMainWindow: vi.fn((options) => {
      createdOptions.push(options);
      const window = new Window(); all.push(window); return window.native;
    }),
    preloadArguments: ["--dohc-dev-tools"],
    get rendererWorkspaceSessions() { return currentSessions; },
  };
  const windows = createDesktopWindows(dependencies);
  return {
    windows, dependencies, sessions, all, templates, createdOptions,
    setRead: (value: typeof read) => { read = value; },
    setStored: (value: typeof stored) => { stored = value; },
    setRows: (value: typeof rows) => { rows = value; },
    setReady: (value: boolean) => { ready = value; },
    setCanInstall: (value: boolean) => { canInstall = value; },
    setRetirement: (value: typeof retirement) => { retirement = value; },
    setSessions: (value: typeof sessions) => { currentSessions = value; },
  };
}

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  if (!Array.isArray(item.submenu)) throw new Error("Expected menu template submenu");
  return item.submenu;
}
function item(f: ReturnType<typeof fixture>, menu: string, label: string) {
  const root = f.templates.at(-1)!.find((entry) => entry.label === menu)!;
  const entry = submenu(root).find((child) => child.label === label);
  if (!entry) throw new Error(`Missing ${menu}/${label}`);
  return entry;
}
function click(entry: MenuItemConstructorOptions, window?: BrowserWindow) {
  entry.click!({} as MenuItem, window, {} as KeyboardEvent);
}

function observePersistedZoomReconciliations(expected = 1): Promise<void> {
  const completed = deferred();
  const resolve = windowZoom.resolvePersistedZoomApplication;
  let remaining = expected;
  vi.spyOn(windowZoom, "resolvePersistedZoomApplication").mockImplementation((...args) => {
    const application = resolve(...args);
    if (--remaining === 0) completed.resolve();
    return application;
  });
  return completed.promise;
}

afterEach(() => vi.restoreAllMocks());

describe("desktop workspace windows", () => {
  it("tracks workspace windows separately from utility windows and forgets closed windows", () => {
    const f = fixture(); const utility = new Window(); const first = new Window(); const second = new Window();
    f.all.push(utility, first, second);
    f.windows.trackWorkspaceWindow(first.native); f.windows.trackWorkspaceWindow(second.native);
    expect(f.windows.liveWorkspaceWindow()).toBe(first.native);
    expect(f.windows.targetWindow(undefined)).toBe(first.native);
    expect(f.windows.targetWindow(utility.native)).toBe(utility.native);
    first.destroy();
    expect(f.windows.workspaceWindows.allLive()).toEqual([second.native]);
    second.destroy();
    expect(f.windows.liveWorkspaceWindow()).toBeUndefined();
    expect(f.windows.targetWindow(undefined)).toBe(utility.native);
  });

  it("activates the target window and prioritizes that workspace without changing the input list", async () => {
    const f = fixture(); const window = new Window(); f.windows.trackWorkspaceWindow(window.native);
    const rows = [workspace("a"), workspace("b"), workspace("c")];
    expect(f.windows.prioritizePreferredWorkspace(rows)).toBe(rows);
    await f.windows.sendWorkspaceActivated(undefined, rows[1]!);
    expect(window.webContents.send).toHaveBeenCalledWith(CHANNELS.workspaceActivated, rows[1]);
    expect(f.windows.prioritizePreferredWorkspace(rows)).toEqual([rows[1], rows[0], rows[2]]);
    expect(rows.map((row) => row.workspaceId)).toEqual(["a", "b", "c"]);
    f.windows.setPreferredWorkspaceId("absent");
    expect(f.windows.prioritizePreferredWorkspace(rows)).toBe(rows);
    f.windows.setPreferredWorkspaceId("a");
    expect(f.windows.prioritizePreferredWorkspace(rows)).toBe(rows);
  });

  it("activates into a new workspace window when only the manager or a utility window is live", async () => {
    const f = fixture(); const rows = [workspace("a"), workspace("b")];
    const utility = new Window(); f.all.push(utility);
    const manager = f.windows.showOrCreateManagerWindow(); const managerWindow = f.all[1]!;
    const pending = f.windows.sendWorkspaceActivated(manager, rows[1]!);
    expect(f.windows.prioritizePreferredWorkspace(rows)[0]).toBe(rows[1]);
    expect(f.dependencies.createMainWindow).toHaveBeenCalledTimes(2);
    const created = f.all[2]!;
    expect(f.createdOptions[1]?.role).toBeUndefined();
    created.finishLoad();
    expect(await pending).toBe(created.native);
    expect(created.webContents.send).toHaveBeenCalledWith(CHANNELS.workspaceActivated, rows[1]);
    expect(managerWindow.webContents.send).not.toHaveBeenCalled();
    expect(utility.webContents.send).not.toHaveBeenCalled();
    expect(created.focus).toHaveBeenCalledOnce();
  });

  it("reports a failed activation as a dialog, not silence", () => {
    const f = fixture();
    f.windows.reportActivationFailure(workspace("a"), new Error("load failed"));
    expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("Open workspace", expect.stringContaining("C:\\work\\a"));
  });

  it("focuses an existing workspace window and creates a tracked window only when none exists", async () => {
    const f = fixture(); const existing = new Window(); existing.minimized = true;
    f.windows.trackWorkspaceWindow(existing.native); f.all.push(existing);
    expect(await f.windows.showOrCreateMainWindow()).toBe(existing.native);
    expect(existing.restore).toHaveBeenCalledOnce(); expect(existing.show).toHaveBeenCalledOnce(); expect(existing.focus).toHaveBeenCalledOnce();
    expect(f.dependencies.createMainWindow).not.toHaveBeenCalled();
    existing.destroy(); f.all.length = 0;
    // A live manager alone is not a place for a handoff to land.
    f.windows.showOrCreateManagerWindow();
    f.windows.seedZoomLevel(2);
    const created = await f.windows.showOrCreateMainWindow(); const native = f.all[1]!;
    expect(created).toBe(native.native);
    expect(f.windows.workspaceWindows.allLive()).toEqual([created]);
    expect(f.createdOptions[1]?.beforeRendererReload).toBe(f.windows.prepareAfterRendererCrash);
    expect(native.webContents.setZoomLevel).toHaveBeenCalledWith(2);
    expect(native.show).not.toHaveBeenCalled();
    native.emit("ready-to-show");
    expect(native.show).toHaveBeenCalledOnce(); expect(native.focus).toHaveBeenCalledOnce();
  });

  it("hands the manager the app zoom and settings broadcasts, never the utility window", async () => {
    const f = fixture(); f.windows.seedZoomLevel(1);
    const manager = f.windows.showOrCreateManagerWindow(); const utility = new Window(); f.all.push(utility);
    const managerWindow = f.all[0]!;
    expect(managerWindow.webContents.setZoomLevel).toHaveBeenCalledWith(1);
    expect(f.createdOptions[0]?.preloadArguments).toEqual(["--dohc-dev-tools"]);
    f.windows.applyZoomLevelToWindows(3);
    expect(managerWindow.webContents.setZoomLevel).toHaveBeenLastCalledWith(3);
    expect(utility.webContents.setZoomLevel).not.toHaveBeenCalled();
    expect(f.windows.workspaceWindows.allLive()).toEqual([]);
    f.windows.broadcastUserSettings(settings(3));
    expect(managerWindow.webContents.send).toHaveBeenCalledWith(CHANNELS.userSettingsChanged, expect.objectContaining({ source: "stored" }));
    expect(utility.webContents.send).not.toHaveBeenCalled();
    managerWindow.destroy();
    expect(manager.isDestroyed()).toBe(true);
    f.windows.applyZoomLevelToWindows(2);
    expect(managerWindow.webContents.setZoomLevel).not.toHaveBeenCalledWith(2);
  });

  it("rejects an open whose window closes or fails to load, and cleans up", async () => {
    const f = fixture();
    const closed = f.windows.openWorkspaceInWindow(workspace("a"), () => false);
    const first = f.all[0]!;
    const loadListeners = first.webContents.listenerCount("did-finish-load");
    first.destroy();
    await expect(closed).rejects.toThrow("closed before it finished loading");
    // The open's own listeners are gone: a late load sends nothing.
    expect(first.webContents.listenerCount("did-finish-load")).toBe(loadListeners - 1);
    expect(first.webContents.listenerCount("did-fail-load")).toBe(0);
    first.finishLoad();
    expect(first.webContents.send).not.toHaveBeenCalled();

    const failed = f.windows.openWorkspaceInWindow(workspace("a"), () => false);
    const second = f.all[1]!;
    second.failLoad(false);
    second.failLoad(true);
    await expect(failed).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
    expect(second.destroyed).toBe(true);
    expect(second.webContents.listenerCount("did-fail-load")).toBe(0);
    expect(second.webContents.send).not.toHaveBeenCalled();
    expect(f.windows.workspaceWindows.allLive()).toEqual([]);
  });

  it("coalesces concurrent opens of one workspace until activation lands", async () => {
    const f = fixture();
    const first = f.windows.openWorkspaceInWindow(workspace("a"), () => false);
    const second = f.windows.openWorkspaceInWindow(workspace("a"), () => false);
    const other = f.windows.openWorkspaceInWindow(workspace("b"), () => false);
    expect(f.dependencies.createMainWindow).toHaveBeenCalledTimes(2);
    f.all[0]!.finishLoad(); f.all[1]!.finishLoad();
    expect(await first).toBe(await second);
    expect(await other).not.toBe(await first);
    expect(f.all[0]!.webContents.send).toHaveBeenCalledTimes(1);
  });

  // Activation is sent, but the renderer has not opened its session yet, so
  // the caller's session lookup still says nothing shows the workspace.
  async function activatedWithoutSession(f: ReturnType<typeof fixture>, id = "a") {
    const opened = await (() => { const p = f.windows.openWorkspaceInWindow(workspace(id), () => false); f.all.at(-1)!.finishLoad(); return p; })();
    const showing = (window: BrowserWindow) => f.sessions.current(window.webContents)?.workspaceId === id;
    return { opened, showing, native: f.all.at(-1)! };
  }

  it("keeps a second open on the same window between activation and session establishment", async () => {
    const f = fixture();
    const { opened, showing, native } = await activatedWithoutSession(f);
    native.minimized = true;
    native.focus.mockClear();
    expect(await f.windows.openWorkspaceInWindow(workspace("a"), showing)).toBe(opened);
    expect(native.restore).toHaveBeenCalledOnce();
    expect(native.focus).toHaveBeenCalledOnce();
    expect(f.dependencies.createMainWindow).toHaveBeenCalledTimes(1);
    expect(native.webContents.send).toHaveBeenCalledTimes(1);
    // The renderer opens its session: the association retires and the lookup
    // takes over.
    await f.sessions.open(native.webContents.native, { workspaceId: "a", attachmentId: Symbol("a") }, "document");
    expect(await f.windows.openWorkspaceInWindow(workspace("a"), showing)).toBe(opened);
    expect(f.dependencies.createMainWindow).toHaveBeenCalledTimes(1);
  });

  it("frees the association when the window switches to another workspace", async () => {
    const f = fixture();
    const { showing, native } = await activatedWithoutSession(f);
    await f.sessions.open(native.webContents.native, { workspaceId: "b", attachmentId: Symbol("b") }, "document");
    const again = f.windows.openWorkspaceInWindow(workspace("a"), showing);
    expect(f.dependencies.createMainWindow).toHaveBeenCalledTimes(2);
    f.all[1]!.finishLoad();
    expect(await again).not.toBe(native.native);
  });

  it("frees the association when the activated window closes before its session opens", async () => {
    const f = fixture();
    const { showing, native } = await activatedWithoutSession(f);
    native.destroy();
    const again = f.windows.openWorkspaceInWindow(workspace("a"), showing);
    expect(f.dependencies.createMainWindow).toHaveBeenCalledTimes(2);
    f.all[1]!.finishLoad();
    expect(await again).toBe(f.all[1]!.native);
  });

  it("restores a minimized manager window instead of creating a second one", () => {
    const f = fixture();
    const first = f.windows.showOrCreateManagerWindow();
    const native = f.all[0]!;
    expect(f.createdOptions[0]?.role).toBe("manager");
    native.minimized = true;
    expect(f.windows.showOrCreateManagerWindow()).toBe(first);
    expect(f.dependencies.createMainWindow).toHaveBeenCalledOnce();
    expect(native.restore).toHaveBeenCalledOnce(); expect(native.show).toHaveBeenCalledOnce(); expect(native.focus).toHaveBeenCalledOnce();
    expect(f.windows.workspaceWindows.allLive()).toEqual([]);
  });

  it("restores a minimized window already showing the workspace instead of creating one", async () => {
    const f = fixture(); const existing = new Window(); existing.minimized = true;
    f.windows.trackWorkspaceWindow(existing.native);
    expect(await f.windows.openWorkspaceInWindow(workspace("a"), (window) => window === existing.native)).toBe(existing.native);
    expect(f.dependencies.createMainWindow).not.toHaveBeenCalled();
    expect(existing.restore).toHaveBeenCalledOnce(); expect(existing.show).toHaveBeenCalledOnce(); expect(existing.focus).toHaveBeenCalledOnce();
    expect(existing.webContents.send).not.toHaveBeenCalled();
  });

  it("routes menu commands and recents through a workspace window, restoring it when minimized", async () => {
    const f = fixture(); const window = new Window(); window.minimized = true;
    f.windows.trackWorkspaceWindow(window.native); f.windows.refreshApplicationMenu();
    const manager = f.windows.showOrCreateManagerWindow();
    const recent = submenu(item(f, "File", "Open Recent"))[1]!;
    click(recent, manager);
    await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledWith(CHANNELS.workspaceActivated, workspace("b")));
    expect(f.all[0]!.webContents.send).not.toHaveBeenCalled();
    expect(window.restore).toHaveBeenCalledOnce(); expect(window.focus).toHaveBeenCalledOnce();
    click(item(f, "Go", "Settings"), manager);
    expect(manager.webContents.send).toHaveBeenCalledWith(CHANNELS.menuCommand, "settings");
  });

  it("re-prioritizes an accepted reload only after the actual renderer retirement drains", async () => {
    const f = fixture(); const sender = new Contents(); const held = deferred();
    const rows = [workspace("a"), workspace("b")];
    await f.sessions.open(sender.native, { workspaceId: "b", attachmentId: Symbol("b") }, "document");
    f.windows.setPreferredWorkspaceId("a"); f.setRetirement(() => held.promise);
    const pending = f.windows.prepareForRendererReload(sender.native, "document");
    try {
      expect(f.sessions.current(sender.native)).toBeUndefined();
      expect(f.windows.prioritizePreferredWorkspace(rows)[0]).toBe(rows[0]);
      held.resolve(); expect(await pending).toBe(true);
      expect(f.windows.prioritizePreferredWorkspace(rows)[0]).toBe(rows[1]);
    } finally { held.resolve(); await pending; }
  });

  it("leaves preference and the active renderer intact when the reload document is stale", async () => {
    const f = fixture(); const sender = new Contents();
    const session = await f.sessions.open(sender.native, { workspaceId: "b", attachmentId: Symbol("b") }, "current");
    f.windows.setPreferredWorkspaceId("a");
    expect(await f.windows.prepareForRendererReload(sender.native, "old")).toBe(false);
    expect(f.sessions.current(sender.native)).toBe(session);
    expect(f.windows.prioritizePreferredWorkspace([workspace("a"), workspace("b")])[0]!.workspaceId).toBe("a");
    await f.sessions.retireAfterCrash(sender.native);
  });

  it("reads the current session owner and remembers a crashed renderer before retirement finishes", async () => {
    const f = fixture(); const sender = new Contents(); const held = deferred();
    const sessions = new RendererWorkspaceSessionOwner<WebContents>({ retirement: {
      retireSender: () => ({ requiredForAdmission: held.promise, detachedFromAdmission: Promise.resolve() }),
      retireWorkspace: async () => undefined,
    } });
    f.setSessions(sessions);
    await sessions.open(sender.native, { workspaceId: "b", attachmentId: Symbol("b") }, "document");
    f.windows.setPreferredWorkspaceId("a");
    const pending = f.windows.prepareAfterRendererCrash(sender.native);
    try {
      expect(sessions.current(sender.native)).toBeUndefined();
      expect(f.windows.prioritizePreferredWorkspace([workspace("a"), workspace("b")])[0]!.workspaceId).toBe("b");
    } finally { held.resolve(); await pending; }
    await f.windows.prepareAfterRendererCrash(sender.native);
    expect(f.windows.prioritizePreferredWorkspace([workspace("a"), workspace("b")])[0]!.workspaceId).toBe("b");
  });
});

describe("desktop window zoom", () => {
  it("seeds before window creation and never overwrites a newer applied zoom with a later seed", () => {
    const f = fixture(); const window = new Window();
    f.windows.seedZoomLevel(1); f.windows.seedZoomLevel(3);
    f.windows.trackWorkspaceWindow(window.native);
    expect(window.webContents.setZoomLevel).toHaveBeenCalledWith(1);
    f.windows.applyZoomLevelToWindows(2); f.windows.seedZoomLevel(4);
    expect(window.webContents.setZoomLevel).toHaveBeenLastCalledWith(2);
  });

  it("applies the first persisted zoom to tracked windows only", async () => {
    const f = fixture(); const held = deferred<DesktopUserSettingsResult>(); const window = new Window(); const utility = new Window();
    f.all.push(window, utility); f.setRead(() => held.promise);
    f.windows.trackWorkspaceWindow(window.native);
    const reconciled = observePersistedZoomReconciliations();
    try {
      window.emit("ready-to-show");
      expect(window.webContents.setZoomLevel).not.toHaveBeenCalled();
      held.resolve(settings(3)); await reconciled;
      expect(window.webContents.setZoomLevel).toHaveBeenCalledWith(3);
      expect(utility.webContents.setZoomLevel).not.toHaveBeenCalled();
    } finally { held.resolve(settings(3)); await reconciled; }
  });

  it("keeps a user zoom ahead of a stale persisted read and skips a destroyed window", async () => {
    const f = fixture(); const held = deferred<DesktopUserSettingsResult>(); const live = new Window(); const closed = new Window();
    f.setRead(() => held.promise); f.windows.trackWorkspaceWindow(live.native); f.windows.trackWorkspaceWindow(closed.native);
    const reconciled = observePersistedZoomReconciliations(2);
    try {
      live.emit("ready-to-show"); closed.emit("ready-to-show");
      f.windows.applyZoomLevelToWindows(2); closed.destroy();
      closed.webContents.setZoomLevel.mockClear(); live.webContents.setZoomLevel.mockClear();
      held.resolve(settings(-2)); await reconciled;
      expect(live.webContents.setZoomLevel).toHaveBeenCalledWith(2);
      expect(closed.webContents.setZoomLevel).not.toHaveBeenCalled();
    } finally { held.resolve(settings(-2)); await reconciled; }
  });

  it("reconciles on renderer load and ignores an unavailable persisted setting", async () => {
    const f = fixture(); const window = new Window(); const held = deferred<DesktopUserSettingsResult>();
    f.setRead(() => held.promise); f.windows.trackWorkspaceWindow(window.native);
    const reconciled = observePersistedZoomReconciliations();
    try {
      window.webContents.emit("did-finish-load");
      held.reject(new Error("settings unavailable"));
      await reconciled;
      expect(window.webContents.setZoomLevel).not.toHaveBeenCalled();
    } finally { held.resolve(settings()); await reconciled; }
  });
});

describe("desktop native menus", () => {
  it("refreshes native menu entries from registry writes by the create and attach IPC handlers", async () => {
    const home = await createTestScratch("registry-native-menu-");
    const registryFile = join(home, "state", "workspaces.json");
    const registry = createRegistryStore(registryFile);
    const workspaceSummaries = () => workspaceSummariesFrom(registry.list());
    const f = fixture("win32", workspaceSummaries);
    const roots = createWorkspaceRootApproval(() => home);
    const handlers = new Map<string, (event: { trusted: boolean }, payload: unknown) => unknown>();
    registerWorkspaceRegistryIpcHandlers<{ trusted: boolean }>({
      registerHandler: (channel, handler) => { handlers.set(channel, handler); },
      assertTrustedSender: (event) => { if (!event.trusted) throw new Error("untrusted"); },
      app: { isPackaged: true },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      roots, effectiveHome: () => home, workspaceSummaries,
      prioritizePreferredWorkspace: f.windows.prioritizePreferredWorkspace,
      createWorkspaceFolder, registerPhysicalWorkspace: registry.register,
      forgetWorkspace: async () => undefined, showItemInFolder: () => undefined,
      openWorkspaceWindow: async () => undefined, openWorkspaceManager: () => undefined, closeWindowOf: () => undefined,
      refreshNativeWorkspaceSurfaces: f.windows.refreshNativeWorkspaceSurfaces,
      desktopMarks: { mark: () => undefined, measureSince: () => undefined },
    });
    const invoke = async (channel: string, payload?: unknown) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing registered handler ${channel}`);
      return handler({ trusted: true }, payload);
    };
    const recentEntries = () => submenu(item(f, "File", "Open Recent"));
    f.windows.refreshNativeWorkspaceSurfaces();
    expect(recentEntries()).toEqual([{ label: "No Recent Workspaces", enabled: false }]);
    const root = await invoke(CHANNELS.getDefaultWorkspaceRoot) as string;
    const created = await invoke(CHANNELS.createLocalWorkspace, {
      rootPath: join(root, "Created Project"), kind: "personal",
    }) as WorkspaceSummary;
    expect(createRegistryStore(registryFile).list()).toEqual([created]);
    expect(recentEntries()).toMatchObject([{ label: "Created Project", sublabel: created.rootPath }]);
    expect(f.templates).toHaveLength(2);

    const attached = await createWorkspaceFolder({
      rootPath: roots.usableRoot(join(root, "Attached Project")), kind: "shared",
      workspaceId: "attached-workspace",
    });
    await expect(invoke(CHANNELS.attachWorkspaceFolder, { rootPath: attached.rootPath })).resolves.toEqual(attached);
    expect(createRegistryStore(registryFile).list()).toEqual([created, attached]);
    expect(recentEntries()).toMatchObject([
      { label: "Created Project", sublabel: created.rootPath },
      { label: "Attached Project", sublabel: attached.rootPath },
    ]);
    expect(f.templates).toHaveLength(3);
    expect(f.dependencies.Menu.setApplicationMenu).toHaveBeenCalledTimes(3);
    expect(vi.mocked(f.dependencies.app.addRecentDocument).mock.calls).toEqual([
      [created.rootPath], [attached.rootPath], [created.rootPath],
    ]);
    expect(vi.mocked(f.dependencies.app.setUserTasks).mock.calls.at(-1)![0]).toMatchObject([
      { title: "Open Created Project", description: created.rootPath },
      { title: "Open Attached Project", description: attached.rootPath },
    ]);
    await expect(invoke(CHANNELS.attachWorkspaceFolder, { rootPath: attached.rootPath })).rejects.toThrow("already attached");
    expect(f.templates).toHaveLength(3);
    expect(createRegistryStore(registryFile).list()).toEqual([created, attached]);

    const target = new Window(); f.windows.trackWorkspaceWindow(target.native);
    click(recentEntries()[1]!, target.native);
    expect(target.webContents.send).toHaveBeenCalledOnce();
    expect(target.webContents.send).toHaveBeenCalledWith(CHANNELS.workspaceActivated, attached);
    await expect(invoke(CHANNELS.getWorkspaceRegistry)).resolves.toEqual({ workspaces: [attached, created] });
  });

  it("does no native work before ready and reads current update availability when rebuilding", () => {
    const f = fixture(); f.setReady(false);
    f.windows.refreshNativeWorkspaceSurfaces(); f.windows.refreshApplicationMenu();
    expect(f.dependencies.Menu.setApplicationMenu).not.toHaveBeenCalled();
    expect(f.dependencies.app.clearRecentDocuments).not.toHaveBeenCalled();
    expect(f.windows.applicationMenuCanInstallUpdate).toBeNull();
    f.setReady(true); f.windows.refreshApplicationMenu();
    expect(item(f, "Help", "Update and Restart").enabled).toBe(false);
    f.setCanInstall(true); f.windows.refreshApplicationMenu();
    expect(item(f, "Help", "Update and Restart").enabled).toBe(true);
    expect(f.windows.applicationMenuCanInstallUpdate).toBe(true);
  });

  it("routes commands to the live target and opens recent workspaces through activation", () => {
    const f = fixture(); const first = new Window(); const explicit = new Window();
    f.windows.trackWorkspaceWindow(first.native); f.windows.trackWorkspaceWindow(explicit.native);
    f.windows.refreshApplicationMenu();
    click(item(f, "File", "New File"));
    expect(first.webContents.send).toHaveBeenCalledWith(CHANNELS.menuCommand, "new-file");
    click(item(f, "Go", "Settings"), explicit.native);
    expect(explicit.webContents.send).toHaveBeenCalledWith(CHANNELS.menuCommand, "settings");
    const recent = submenu(item(f, "File", "Open Recent"))[1]!;
    click(recent, explicit.native);
    expect(explicit.webContents.send).toHaveBeenCalledWith(CHANNELS.workspaceActivated, workspace("b"));
    expect(f.windows.prioritizePreferredWorkspace([workspace("a"), workspace("b")])[0]!.workspaceId).toBe("b");
    expect(f.dependencies.app.clearRecentDocuments).toHaveBeenCalledOnce();
  });

  it("uses current native windows when an older menu callback fires", () => {
    const f = fixture(); const first = new Window(); const second = new Window();
    f.windows.trackWorkspaceWindow(first.native); f.windows.refreshApplicationMenu(); const command = item(f, "Go", "Settings");
    first.destroy(); f.windows.trackWorkspaceWindow(second.native); click(command);
    expect(first.webContents.send).not.toHaveBeenCalled();
    expect(second.webContents.send).toHaveBeenCalledWith(CHANNELS.menuCommand, "settings");
  });

  it("reuses native recents for cloned roots while rebuilding current menus", () => {
    const f = fixture();
    f.windows.refreshNativeWorkspaceSurfaces();
    expect(item(f, "Help", "Update and Restart").enabled).toBe(false);

    const rows = [workspace("replacement", workspace("a").rootPath), workspace("b")];
    f.setRows(rows);
    f.setCanInstall(true);
    f.windows.refreshNativeWorkspaceSurfaces();
    f.setRows(structuredClone(rows));
    f.windows.refreshNativeWorkspaceSurfaces();

    expect(f.dependencies.app.clearRecentDocuments).toHaveBeenCalledOnce();
    expect(f.dependencies.app.addRecentDocument).toHaveBeenCalledTimes(2);
    expect(f.dependencies.app.setUserTasks).toHaveBeenCalledOnce();
    expect(f.dependencies.Menu.setApplicationMenu).toHaveBeenCalledTimes(3);
    expect(item(f, "Help", "Update and Restart").enabled).toBe(true);
    const target = new Window();
    f.windows.trackWorkspaceWindow(target.native);
    click(submenu(item(f, "File", "Open Recent"))[0]!, target.native);
    expect(target.webContents.send).toHaveBeenCalledWith(CHANNELS.workspaceActivated, rows[0]);
    expect(f.dependencies.app.clearRecentDocuments).toHaveBeenCalledOnce();
  });

  it.each<NodeJS.Platform>(["win32", "darwin", "linux"])(
    "refreshes changed root order, additions, and removals on %s",
    (platform) => {
      const f = fixture(platform);
      const lists = [
        [workspace("a"), workspace("b")],
        [workspace("b"), workspace("a")],
        [workspace("b"), workspace("a"), workspace("c")],
        [workspace("a")],
        [],
      ];
      for (const rows of lists) {
        f.setRows(rows);
        f.windows.refreshNativeWorkspaceSurfaces();
        f.setRows(structuredClone(rows));
        f.windows.refreshNativeWorkspaceSurfaces();
      }
      expect(f.dependencies.app.clearRecentDocuments).toHaveBeenCalledTimes(lists.length);
      expect(vi.mocked(f.dependencies.app.addRecentDocument).mock.calls).toEqual(
        lists.flatMap((rows) => [...rows].reverse().map((row) => [row.rootPath])),
      );
      expect(f.dependencies.app.setUserTasks).toHaveBeenCalledTimes(platform === "win32" ? lists.length : 0);
      expect(f.dependencies.Menu.setApplicationMenu).toHaveBeenCalledTimes(lists.length * 2);
    },
  );

  it.each(
    (["clear", "add", "tasks-false", "tasks-throw"] as const).flatMap((failure) =>
      (["failed", "previous"] as const).map((retry) => ({ failure, retry })),
    ),
  )(
    "retries the $retry root list after $failure fails",
    ({ failure, retry }) => {
      const f = fixture();
      f.windows.refreshNativeWorkspaceSurfaces();
      const fail = () => { throw new Error("native storage failed"); };
      if (failure === "clear") vi.mocked(f.dependencies.app.clearRecentDocuments).mockImplementationOnce(fail);
      if (failure === "add") vi.mocked(f.dependencies.app.addRecentDocument).mockImplementationOnce(fail);
      if (failure === "tasks-false") vi.mocked(f.dependencies.app.setUserTasks).mockReturnValueOnce(false);
      if (failure === "tasks-throw") vi.mocked(f.dependencies.app.setUserTasks).mockImplementationOnce(fail);
      f.setRows([workspace("c")]);
      if (failure === "tasks-throw") {
        expect(() => f.windows.refreshNativeWorkspaceSurfaces()).toThrow("native storage failed");
      } else {
        f.windows.refreshNativeWorkspaceSurfaces();
      }
      expect(f.dependencies.Menu.setApplicationMenu).toHaveBeenCalledTimes(2);

      f.setRows(retry === "previous" ? [workspace("a"), workspace("b")] : [workspace("c")]);
      f.windows.refreshNativeWorkspaceSurfaces();
      f.windows.refreshNativeWorkspaceSurfaces();
      expect(f.dependencies.app.clearRecentDocuments).toHaveBeenCalledTimes(3);
      expect(f.dependencies.app.setUserTasks).toHaveBeenCalledTimes(3);
      expect(f.dependencies.Menu.setApplicationMenu).toHaveBeenCalledTimes(4);
    },
  );

  it("reverses native recents, limits Windows tasks, and quotes roots exactly", () => {
    const f = fixture(); const rows = Array.from({ length: 12 }, (_, index) => workspace(`w${index}`));
    rows[0] = workspace("quoted", "C:\\say\"hi\\"); f.setRows(rows);
    f.windows.refreshNativeWorkspaceSurfaces();
    expect(vi.mocked(f.dependencies.app.addRecentDocument).mock.calls).toEqual([...rows].reverse().map((row) => [row.rootPath]));
    const tasks = vi.mocked(f.dependencies.app.setUserTasks).mock.calls[0]![0];
    expect(tasks).toHaveLength(10);
    expect(tasks[0]).toEqual({ program: "C:\\dohc\\dohc.exe", iconPath: "C:\\dohc\\dohc.exe", iconIndex: 0,
      arguments: '--open-workspace "C:\\say\\"hi\\\\"', title: 'Open say"hi', description: rows[0].rootPath });
    expect(submenu(item(f, "File", "Open Recent"))).toHaveLength(10);
  });

  it("tolerates a malformed registry for native menus while leaving strict reads with their caller", () => {
    const f = fixture(); vi.mocked(f.dependencies.workspaceSummaries).mockImplementation(() => { throw new Error("registry failed"); });
    f.windows.refreshNativeWorkspaceSurfaces();
    expect(f.dependencies.app.addRecentDocument).not.toHaveBeenCalled();
    expect(f.dependencies.app.setUserTasks).toHaveBeenCalledWith([]);
    expect(submenu(item(f, "File", "Open Recent"))).toEqual([{ label: "No Recent Workspaces", enabled: false }]);
    expect(() => f.dependencies.workspaceSummaries()).toThrow("registry failed");
  });

  it("still rebuilds the menu if native recent-document storage fails on Linux", () => {
    const f = fixture("linux"); vi.mocked(f.dependencies.app.clearRecentDocuments).mockImplementation(() => { throw new Error("unsupported"); });
    f.windows.refreshNativeWorkspaceSurfaces();
    expect(f.dependencies.Menu.setApplicationMenu).toHaveBeenCalledOnce();
    expect(f.dependencies.app.setUserTasks).not.toHaveBeenCalled();
  });

  it.each([new Error("dohc did not save settings. Fix the file."), "unreadable settings"])("reports accelerator zoom rejection %s", async (error) => {
    const f = fixture(); const reported = deferred();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(f.dependencies.stepWindowZoom).mockRejectedValueOnce(error);
    vi.mocked(f.dependencies.dialog.showErrorBox).mockImplementation(() => { reported.resolve(); });
    f.windows.refreshApplicationMenu(); click(item(f, "View", "Zoom In"));
    await reported.promise;
    expect(f.dependencies.stepWindowZoom).toHaveBeenCalledExactlyOnceWith("in");
    // The refusal already names the file and the way out.
    expect(f.dependencies.dialog.showErrorBox).toHaveBeenCalledWith("Zoom", error instanceof Error
      ? "dohc did not save settings. Fix the file." : "dohc could not change the window zoom.");
  });

  it("uses the existing About dialog content", () => {
    const f = fixture(); f.windows.refreshApplicationMenu(); click(item(f, "Help", "About dohc"));
    expect(f.dependencies.dialog.showMessageBox).toHaveBeenCalledWith({
      title: "About dohc", message: "dohc", detail: "Version 1.2.3\nYour workspace is a folder.",
    });
  });
});
