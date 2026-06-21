import { describe, expect, it, vi } from "vitest";
import {
  publicUpdateState,
  resolveUpdateChannel,
  startAutoUpdates,
  updateFeedOverride,
  type AutoUpdateController,
} from "./electronUpdater";
import { initialUpdateState, transition } from "./updateMachine";

type Listener = (...args: unknown[]) => void;

function fakeUpdater() {
  const listeners = new Map<string, Listener[]>();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: undefined as string | undefined,
    allowPrerelease: undefined as boolean | undefined,
    allowDowngrade: undefined as boolean | undefined,
    forceDevUpdateConfig: undefined as boolean | undefined,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on: vi.fn((eventName: string, listener: Listener) => {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]);
    }),
    emit(eventName: string, ...args: unknown[]) {
      for (const listener of listeners.get(eventName) ?? []) listener(...args);
    },
  };
  updater.quitAndInstall.mockImplementation(() => {
    updater.emit("before-quit-for-update");
  });
  return updater;
}

async function startWith(updater: ReturnType<typeof fakeUpdater>, options: {
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
  currentVersion?: string;
  onBeforeQuitForUpdate?: () => void;
} = {}): Promise<AutoUpdateController | null> {
  return startAutoUpdates({
    isPackaged: options.isPackaged ?? true,
    env: options.env ?? {},
    currentVersion: options.currentVersion ?? "1.2.3",
    startupDelayMs: 60 * 60_000,
    pollIntervalMs: 60 * 60_000,
    onBeforeQuitForUpdate: options.onBeforeQuitForUpdate,
    importUpdater: async () => ({ autoUpdater: updater }),
  });
}

describe("electron updater configuration", () => {
  it("derives latest/nightly channels from semver-compatible versions", () => {
    expect(resolveUpdateChannel("1.2.3")).toBe("latest");
    expect(resolveUpdateChannel("1.2.4-nightly.20260621.123")).toBe("nightly");
    expect(resolveUpdateChannel("1.2.4-nightly.20260621.123.2")).toBe("nightly");
  });

  it("uses a baked packaged app-update.yml feed unless an override is explicit", async () => {
    const updater = fakeUpdater();
    const controller = await startWith(updater, { isPackaged: true, env: {} });

    expect(controller).not.toBeNull();
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.channel).toBe("latest");
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it("honors DOHC_UPDATE_URL only for packaged builds or explicit dev mock mode", async () => {
    expect(updateFeedOverride({ DOHC_UPDATE_URL: "https://updates.test" }, false)).toBeNull();
    expect(
      updateFeedOverride(
        { DOHC_UPDATE_URL: "https://updates.test", DOHC_DESKTOP_MOCK_UPDATES: "1" },
        false,
      ),
    ).toBe("https://updates.test");

    const ignored = fakeUpdater();
    await expect(
      startWith(ignored, {
        isPackaged: false,
        env: { DOHC_UPDATE_URL: "https://updates.test" },
      }),
    ).resolves.toBeNull();
    expect(ignored.setFeedURL).not.toHaveBeenCalled();

    const mocked = fakeUpdater();
    await startWith(mocked, {
      isPackaged: false,
      env: { DOHC_UPDATE_URL: "https://updates.test", DOHC_DESKTOP_MOCK_UPDATES: "1" },
    });
    expect(mocked.forceDevUpdateConfig).toBe(true);
    expect(mocked.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://updates.test",
    });
  });

  it("sets nightly channel flags explicitly", async () => {
    const updater = fakeUpdater();
    await startWith(updater, { currentVersion: "1.2.4-nightly.20260621.123" });

    expect(updater.channel).toBe("nightly");
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
  });
});

describe("electron updater actions", () => {
  it("coalesces repeated checks while one is active", async () => {
    const updater = fakeUpdater();
    const controller = await startWith(updater);
    expect(controller).not.toBeNull();

    const first = await controller!.checkForUpdates();
    const second = await controller!.checkForUpdates();

    expect(first.checked).toBe(true);
    expect(second.checked).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("installs only after update-downloaded and only once", async () => {
    const updater = fakeUpdater();
    const controller = await startWith(updater);
    expect(controller).not.toBeNull();

    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: false,
    });

    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "1.2.4" });

    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: true,
    });
    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: false,
    });
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("bounds progress exposed to the renderer", async () => {
    const updater = fakeUpdater();
    const controller = await startWith(updater);
    expect(controller).not.toBeNull();

    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "1.2.4" });
    updater.emit("download-progress", { percent: 150 });

    expect(controller!.publicState()).toMatchObject({
      status: "downloading",
      percent: 100,
    });
  });

  it("runs bounded quit cleanup before installing updates", async () => {
    const updater = fakeUpdater();
    const onBeforeQuitForUpdate = vi.fn();
    const controller = await startWith(updater, { onBeforeQuitForUpdate });
    expect(controller).not.toBeNull();

    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "1.2.4" });
    await controller!.installUpdate();

    expect(onBeforeQuitForUpdate).toHaveBeenCalledTimes(2);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("runs bounded quit cleanup for updater before-quit-for-update events", async () => {
    const updater = fakeUpdater();
    const onBeforeQuitForUpdate = vi.fn();
    await startWith(updater, { onBeforeQuitForUpdate });

    updater.emit("before-quit-for-update");

    expect(onBeforeQuitForUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("publicUpdateState", () => {
  it("exposes bounded action flags without trusting persisted state", () => {
    const ready = transition(initialUpdateState, { type: "check" });
    expect(
      publicUpdateState(ready, {
        currentVersion: "1.0.0",
        channel: "latest",
        checkInFlight: true,
      }),
    ).toMatchObject({ canCheck: false, canInstall: false });
  });
});
