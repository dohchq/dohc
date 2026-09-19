import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopTray } from "./desktopTray";
import { createChatDispatchService } from "../agents/chatDispatchService";
import { DEFAULT_USER_SETTINGS } from "../settings/userSettings";
import { readCachedUserSettingsFile, writeUserSettingsFile } from "../settings/userSettingsStore";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

async function harness(platform: NodeJS.Platform = "win32", packaged = false) {
  const root = await createTestScratch("desktop-tray-");
  const stateRoot = join(root, "state");
  const moduleDirectory = join(root, "dist", "main");
  const resourcesPath = join(root, "resources");
  const iconRoot = packaged ? resourcesPath : join(root, "build");
  await mkdir(iconRoot, { recursive: true });
  const configure = (enabled: boolean, command = "agent run") => writeUserSettingsFile(stateRoot, {
    ...DEFAULT_USER_SETTINGS, profile: { agentName: "Nova" }, runner: { enabled, command, timeoutMinutes: 30 },
  });
  await configure(true);
  const service = createChatDispatchService({
    workspaceFor: () => null, listOpenWorkspaces: () => [], listSyncWorkspaces: () => [],
    chatStoreFor: () => { throw new Error("No workspace should be opened"); },
    dispatchStoreFor: () => { throw new Error("No dispatch store should be opened"); },
    readRunnerSettings: async () => (await readCachedUserSettingsFile(stateRoot)).settings.runner,
    identityFor: async () => ({ displayName: "Nova", ownerDisplayName: "Local" }), stateDir: () => stateRoot,
    appRoot: () => root, isPackaged: () => packaged, queueSync: () => undefined,
    authorizeServiceNote: async () => false, onMessagePosted: () => undefined,
    setRunAttribution: () => undefined,
  });
  cleanups.push(() => service.stop());
  const emptyPaths = new Set<string>();
  class Image {
    readonly setTemplateImage = vi.fn((_value: boolean) => undefined);
    constructor(readonly path: string) {}
    isEmpty() { return !existsSync(this.path) || emptyPaths.has(this.path); }
  }
  const created: Tray[] = [];
  class Tray {
    menu: MenuItemConstructorOptions[] = [];
    readonly setContextMenu = vi.fn((menu: MenuItemConstructorOptions[]) => { this.menu = menu; });
    readonly setToolTip = vi.fn((_text: string) => undefined);
    readonly setImage = vi.fn((_image: Image) => undefined);
    readonly destroy = vi.fn(() => undefined);
    readonly listeners = new Map<string, () => void>();
    constructor(readonly image: Image) { created.push(this); }
    on(event: "double-click", listener: () => void) { this.listeners.set(event, listener); return this; }
  }
  const app = { isPackaged: packaged, getAppPath: () => root, quit: vi.fn(), dock: { setIcon: vi.fn((_path: string) => undefined) } };
  const runtime = { platform, resourcesPath: resourcesPath as string | undefined };
  const theme = { shouldUseDarkColors: false };
  const windows = [{ setIcon: vi.fn((_path: string) => undefined) }];
  const readSettings = vi.fn(readCachedUserSettingsFile);
  const createImage = vi.fn((path: string) => new Image(path));
  const buildMenu = vi.fn((template: MenuItemConstructorOptions[]) => template);
  const showWindow = vi.fn(async () => undefined);
  let lifecycle: { isQuitting(): boolean } | undefined;
  const owner = createDesktopTray({
    app, process: runtime, moduleDirectory, Menu: { buildFromTemplate: buildMenu },
    nativeImage: { createFromPath: createImage }, nativeTheme: theme, Tray,
    BrowserWindow: { getAllWindows: () => windows },
    readCachedUserSettingsFile: readSettings, stateDir: () => stateRoot,
    chatDispatchService: service, showOrCreateMainWindow: showWindow,
    get appLifecycle() { if (!lifecycle) throw new Error("Lifecycle has not been constructed"); return lifecycle; },
  });
  lifecycle = { isQuitting: () => false };
  return {
    root, iconRoot, resourcesPath, stateRoot, created, service, app, runtime, theme, windows,
    owner, readSettings, createImage, emptyPaths, buildMenu, showWindow, configure,
    asset: async (name: string) => { const path = join(iconRoot, name); await writeFile(path, "native image fixture"); return path; },
    setLifecycle: (value: { isQuitting(): boolean }) => { lifecycle = value; },
    click: (index: number, checked = false) => {
      const item = created.at(-1)?.menu[index];
      if (!item?.click) throw new Error("Missing tray action");
      Reflect.apply(item.click, undefined, [{ checked }]);
    },
  };
}

describe("desktop tray owner", () => {
  it("creates one tray from persisted settings, refreshes its menu, and recreates it after disable", async () => {
    const h = await harness();
    const light = await h.asset("icon-light.png");
    await expect(h.owner.refreshDispatchTray()).resolves.toBe(true);
    await expect(h.owner.refreshDispatchTray()).resolves.toBe(true);
    expect(h.created).toHaveLength(1);
    const first = h.created[0]!;
    expect(first.image.path).toBe(light);
    expect(first.setToolTip).toHaveBeenCalledWith("dohc agent dispatch");
    expect(first.setContextMenu).toHaveBeenCalledTimes(2);
    expect(first.menu.map(({ label, type, checked }) => ({ label, type, checked }))).toEqual([
      { label: "Open dohc", type: undefined, checked: undefined },
      { label: "Pause agent dispatch", type: "checkbox", checked: false },
      { label: undefined, type: "separator", checked: undefined },
      { label: "Quit dohc", type: undefined, checked: undefined },
    ]);
    await h.configure(false);
    await expect(h.owner.refreshDispatchTray()).resolves.toBe(false);
    await h.owner.refreshDispatchTray();
    expect(first.destroy).toHaveBeenCalledTimes(1);
    await h.configure(true);
    await h.owner.refreshDispatchTray();
    expect(h.created).toHaveLength(2);
    expect(h.created[1]).not.toBe(first);
    expect(h.readSettings).toHaveBeenCalledWith(h.stateRoot);
  });

  it("routes tray actions and keeps the checkbox tied to the real dispatch pause state", async () => {
    const h = await harness();
    await h.asset("icon-light.png");
    await h.owner.refreshDispatchTray();
    h.click(1, true);
    expect(h.service.isPaused()).toBe(true);
    expect(h.created[0]!.menu[1]?.checked).toBe(true);
    h.service.setPaused(false);
    await h.owner.refreshDispatchTray();
    expect(h.created[0]!.menu[1]?.checked).toBe(false);
    h.click(0);
    h.created[0]!.listeners.get("double-click")!();
    h.click(3);
    expect(h.showWindow).toHaveBeenCalledTimes(2);
    expect(h.app.quit).toHaveBeenCalledTimes(1);
    expect(h.created).toHaveLength(1);
  });

  it.each(["win32", "linux"] as const)("refreshes all current %s window icons and the existing tray from the live theme", async (platform) => {
    const h = await harness(platform);
    await h.asset("icon-light.png");
    const dark = await h.asset("icon-dark.png");
    await h.owner.refreshDispatchTray();
    const nextWindow = { setIcon: vi.fn((_path: string) => undefined) };
    h.windows.push(nextWindow);
    h.theme.shouldUseDarkColors = true;
    h.owner.refreshSystemThemeDesktopIcons();
    for (const window of h.windows) expect(window.setIcon).toHaveBeenCalledWith(dark);
    expect(h.app.dock.setIcon).not.toHaveBeenCalled();
    expect(h.created[0]!.setImage.mock.calls[0]?.[0].path).toBe(dark);
    expect(h.created).toHaveLength(1);
  });

  it("uses the macOS Dock and marks both initial and refreshed tray images as templates", async () => {
    const h = await harness("darwin", true);
    const light = await h.asset("icon-light.png");
    const dark = await h.asset("icon-dark.png");
    await h.owner.refreshDispatchTray();
    expect(h.created[0]!.image.path).toBe(light);
    expect(h.created[0]!.image.setTemplateImage).toHaveBeenCalledWith(true);
    h.theme.shouldUseDarkColors = true;
    h.owner.refreshSystemThemeDesktopIcons();
    expect(h.app.dock.setIcon).toHaveBeenCalledWith(dark);
    expect(h.windows[0]!.setIcon).not.toHaveBeenCalled();
    expect(h.created[0]!.setImage.mock.calls[0]?.[0].setTemplateImage).toHaveBeenCalledWith(true);
  });

  it("refreshes system icons before a tray exists without creating one", async () => {
    const h = await harness();
    const light = await h.asset("icon-light.png");
    h.owner.refreshSystemThemeDesktopIcons();
    expect(h.windows[0]!.setIcon).toHaveBeenCalledWith(light);
    expect(h.created).toEqual([]);
    expect(h.readSettings).not.toHaveBeenCalled();
  });

  it("uses the unthemed icon when the current themed file is absent", async () => {
    const h = await harness();
    const fallback = await h.asset("icon.png");
    await h.owner.refreshDispatchTray();
    expect(h.created[0]!.image.path).toBe(fallback);
    expect(h.createImage).toHaveBeenCalledTimes(1);
  });

  it("uses packaged tray fallback bytes when no general icon exists", async () => {
    const h = await harness("win32", true);
    const fallback = await h.asset("tray-icon.png");
    await h.owner.refreshDispatchTray();
    expect(h.created[0]!.image.path).toBe(fallback);
    h.owner.refreshSystemThemeDesktopIcons();
    expect(h.windows[0]!.setIcon).not.toHaveBeenCalled();
    expect(h.created[0]!.setImage.mock.calls[0]?.[0].path).toBe(fallback);
  });

  it("falls back to the app build icon when native decoding rejects the resolved image", async () => {
    const h = await harness();
    const light = await h.asset("icon-light.png");
    const fallback = await h.asset("icon.png");
    h.emptyPaths.add(light);
    await h.owner.refreshDispatchTray();
    expect(h.createImage.mock.calls).toEqual([[light], [fallback]]);
    expect(h.created[0]!.image.path).toBe(fallback);
  });

  it("preserves the empty-path fallback when the process has no resources directory", async () => {
    const h = await harness();
    h.runtime.resourcesPath = undefined;
    await h.owner.refreshDispatchTray();
    expect(h.createImage.mock.calls).toEqual([[""], [join(h.root, "build/icon.png")]]);
  });

  it.each([false, true])("checks the current lifecycle after a held settings read with an existing tray: %s", async (existing) => {
    const h = await harness();
    await h.asset("icon-light.png");
    if (existing) await h.owner.refreshDispatchTray();
    const reached = deferred<void>();
    const release = deferred<void>();
    h.readSettings.mockImplementation(async (path) => { reached.resolve(); await release.promise; return readCachedUserSettingsFile(path); });
    const pending = h.owner.refreshDispatchTray();
    try {
      await reached.promise;
      h.setLifecycle({ isQuitting: () => true });
      expect(h.created).toHaveLength(existing ? 1 : 0);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
    await expect(pending).resolves.toBe(true);
    expect(h.created).toHaveLength(existing ? 1 : 0);
    if (existing) expect(h.created[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it("propagates a settings-read rejection while preserving the existing tray", async () => {
    const h = await harness();
    await h.asset("icon-light.png");
    await h.owner.refreshDispatchTray();
    h.readSettings.mockRejectedValue(new Error("settings failed"));
    await expect(h.owner.refreshDispatchTray()).rejects.toThrow("settings failed");
    expect(h.created[0]!.destroy).not.toHaveBeenCalled();
    expect(h.created[0]!.setContextMenu).toHaveBeenCalledTimes(1);
  });

  it("requires a nonblank runner command even when an injected settings source marks it enabled", async () => {
    const h = await harness();
    h.readSettings.mockResolvedValue({ source: "stored", settings: { ...DEFAULT_USER_SETTINGS, profile: { agentName: "Nova" }, runner: { enabled: true, command: " \t ", timeoutMinutes: 30 } } });
    await expect(h.owner.refreshDispatchTray()).resolves.toBe(false);
    expect(h.created).toEqual([]);
  });
});
