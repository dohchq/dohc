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

function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    const check = deferred<undefined>();
    updater.checkForUpdates.mockReturnValueOnce(check.promise);
    const controller = await startWith(updater);
    expect(controller).not.toBeNull();

    const first = controller!.checkForUpdates();
    updater.emit("checking-for-update");
    const second = controller!.checkForUpdates();

    await expect(second).resolves.toMatchObject({ checked: false });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.emit("update-not-available");
    check.resolve(undefined);
    await expect(first).resolves.toMatchObject({
      checked: true,
      state: { status: "up-to-date" },
    });
  });

  it("recovers when a check rejects after entering checking without an error event", async () => {
    const updater = fakeUpdater();
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit("checking-for-update");
      throw new Error("socket failed");
    });
    const controller = await startWith(updater);
    expect(controller).not.toBeNull();

    await expect(controller!.checkForUpdates()).resolves.toMatchObject({
      checked: false,
      state: { status: "error", canCheck: true },
    });
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

  it("runs bounded quit cleanup when the updater begins installing", async () => {
    const updater = fakeUpdater();
    const onBeforeQuitForUpdate = vi.fn();
    const controller = await startWith(updater, { onBeforeQuitForUpdate });
    expect(controller).not.toBeNull();

    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "1.2.4" });
    await controller!.installUpdate();

    expect(onBeforeQuitForUpdate).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("reports quitAndInstall failures as rejected restart requests", async () => {
    const updater = fakeUpdater();
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("quit failed");
    });
    const controller = await startWith(updater);
    expect(controller).not.toBeNull();

    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "1.2.4" });

    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: false,
      state: {
        status: "ready",
        canInstall: true,
        message: "Could not restart into the update.",
      },
    });
  });

  it("surfaces updater install error events while keeping the update retryable", async () => {
    const updater = fakeUpdater();
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit("error", new Error("quit failed"));
    });
    const controller = await startWith(updater);
    expect(controller).not.toBeNull();

    updater.emit("checking-for-update");
    updater.emit("update-downloaded", { version: "1.2.4" });

    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: false,
      state: {
        status: "ready",
        canInstall: true,
        message: "Could not restart into the update.",
      },
    });
  });

  it("runs bounded quit cleanup for updater before-quit-for-update events", async () => {
    const updater = fakeUpdater();
    const onBeforeQuitForUpdate = vi.fn();
    await startWith(updater, { onBeforeQuitForUpdate });

    updater.emit("before-quit-for-update");

    expect(onBeforeQuitForUpdate).toHaveBeenCalledTimes(1);
  });

  it("stops scheduled checks when the controller is stopped", async () => {
    vi.useFakeTimers();
    try {
      const updater = fakeUpdater();
      const controller = await startWith(updater);
      expect(controller).not.toBeNull();

      controller!.stop();
      vi.advanceTimersByTime(60 * 60_000);

      expect(updater.checkForUpdates).not.toHaveBeenCalled();
      await expect(controller!.checkForUpdates()).resolves.toMatchObject({
        checked: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("publicUpdateState", () => {
  it("gates actions during an active check", () => {
    const checking = transition(initialUpdateState, { type: "check" });
    expect(
      publicUpdateState(checking, {
        currentVersion: "1.0.0",
        channel: "latest",
        checkInFlight: true,
      }),
    ).toMatchObject({ canCheck: false, canInstall: false });
  });

  it("enables install when an update is downloaded and ready", () => {
    const checking = transition(initialUpdateState, { type: "check" });
    const ready = transition(checking, { type: "downloaded", version: "1.0.1" });

    expect(
      publicUpdateState(ready, {
        currentVersion: "1.0.0",
        channel: "latest",
      }),
    ).toMatchObject({
      status: "ready",
      version: "1.0.1",
      canCheck: false,
      canInstall: true,
    });
  });

  it("keeps checks available after retryable error and offline states", () => {
    expect(
      publicUpdateState(transition(initialUpdateState, { type: "error", message: "boom" }), {
        currentVersion: "1.0.0",
        channel: "latest",
      }),
    ).toMatchObject({ status: "error", canCheck: true, canInstall: false });
    expect(
      publicUpdateState(transition(initialUpdateState, { type: "offline" }), {
        currentVersion: "1.0.0",
        channel: "latest",
      }),
    ).toMatchObject({ status: "offline", canCheck: true, canInstall: false });
  });

  it("carries current version and channel through public state", () => {
    expect(
      publicUpdateState(initialUpdateState, {
        currentVersion: "1.0.1-nightly.20260621.12.2",
        channel: "nightly",
      }),
    ).toMatchObject({
      currentVersion: "1.0.1-nightly.20260621.12.2",
      channel: "nightly",
      canCheck: true,
      canInstall: false,
    });
  });
});
