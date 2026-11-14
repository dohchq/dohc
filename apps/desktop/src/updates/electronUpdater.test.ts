import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  debInstallFailure,
  startAutoUpdates,
  updateFeedOverride,
  type AutoUpdateController,
} from "./electronUpdater";
import { deferred } from "../testing/deferred";
import { UpdateStateEvent } from "../ipc/bridgeContract";

type Listener = (...args: unknown[]) => void;

function fakeUpdater() {
  const listeners = new Map<string, Listener[]>();
  let channel: string | undefined;
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    get channel(): string | undefined {
      return channel;
    },
    // electron-updater's channel setter also turns allowDowngrade on. The
    // double does the same, so a controller that sets the channel after
    // refusing downgrades fails here as it would in a packaged build.
    set channel(value: string | undefined) {
      channel = value;
      this.allowDowngrade = true;
    },
    allowPrerelease: undefined as boolean | undefined,
    allowDowngrade: undefined as boolean | undefined,
    forceDevUpdateConfig: undefined as boolean | undefined,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async (): Promise<unknown> => undefined),
    quitAndInstall: vi.fn(),
    install: vi.fn((_isSilent?: boolean, _isForceRunAfter?: boolean): boolean => false),
    on: vi.fn((eventName: string, listener: Listener) => {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]);
    }),
    emit(eventName: string, ...args: unknown[]) {
      for (const listener of listeners.get(eventName) ?? []) listener(...args);
    },
  };
  // electron-updater's quitAndInstall is ONE-SHOT: a
  // second call returns without quitting. The double models the latch so a
  // test can never pass by relying on a re-call the dependency ignores.
  // install() spends the same latch.
  let quitAndInstallLatched = false;
  updater.quitAndInstall.mockImplementation(() => {
    if (quitAndInstallLatched) return;
    quitAndInstallLatched = true;
    updater.emit("before-quit-for-update");
  });
  updater.install.mockImplementation(() => {
    if (quitAndInstallLatched) return false;
    quitAndInstallLatched = true;
    return true;
  });
  return updater;
}

// dohc's quit handler runs first. electron-updater's own install on quit
// (BaseUpdater.addQuitHandler) runs after it: a silent install that does not
// open dohc again, skipped once an install started or on an error exit.
function fakeApp(updater: ReturnType<typeof fakeUpdater>) {
  const handlers: ((exitCode: number) => void)[] = [];
  return {
    quit: vi.fn(),
    onQuit: (handler: (exitCode: number) => void) => {
      handlers.push(handler);
    },
    exit(exitCode: number) {
      for (const handler of handlers) handler(exitCode);
      if (updater.autoInstallOnAppQuit && exitCode === 0) updater.install(true, false);
    },
  };
}

function startedInstalls(updater: ReturnType<typeof fakeUpdater>): unknown[][] {
  return updater.install.mock.calls.filter(
    (_call, index) => updater.install.mock.results[index]?.value === true,
  );
}

async function startWith(
  updater: ReturnType<typeof fakeUpdater> & { isUpdaterActive?: () => boolean },
  options: {
    isPackaged?: boolean;
    env?: NodeJS.ProcessEnv;
    currentVersion?: string;
    app?: ReturnType<typeof fakeApp>;
    restartApproved?: () => boolean;
    stateDir?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<AutoUpdateController | null> {
  const app = options.app ?? fakeApp(updater);
  return startAutoUpdates({
    isPackaged: options.isPackaged ?? true,
    env: options.env ?? {},
    currentVersion: options.currentVersion ?? "1.2.3",
    startupDelayMs: 60 * 60_000,
    pollIntervalMs: 60 * 60_000,
    quit: app.quit,
    onQuit: app.onQuit,
    restartApproved: options.restartApproved,
    stateDir: options.stateDir,
    importUpdater: async () => ({ autoUpdater: updater }),
    platform: options.platform ?? "win32",
  });
}

// electron-updater emits "error" with the provider's coded error, then
// rejects the check with the same error.
function failChecksWith(updater: ReturnType<typeof fakeUpdater>, error: Error) {
  updater.checkForUpdates.mockImplementation(async () => {
    updater.emit("checking-for-update");
    updater.emit("error", error);
    throw error;
  });
}

function channelFileNotFound(): Error {
  return Object.assign(
    new Error(
      "Cannot find nightly-mac.yml in the latest release artifacts (https://github.com/dohchq/dohc/releases/download/v0.1.1-nightly.20261019.42.1/nightly-mac.yml): HttpError: 404",
    ),
    { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" },
  );
}

describe("electron updater configuration", () => {
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

  it("installs on Linux only when the person asks, never at quit", async () => {
    for (const platform of ["win32", "darwin"] as const) {
      const updater = fakeUpdater();
      await startWith(updater, { platform });
      expect(updater.autoInstallOnAppQuit).toBe(true);
    }
    const updater = fakeUpdater();
    const controller = await startWith(updater, { platform: "linux" });
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.autoDownload).toBe(false);
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "1.2.4" });
    controller!.downloadUpdate();
    updater.emit("update-downloaded", { version: "1.2.4" });
    expect((await controller!.installUpdate()).accepted).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("starts no updater where it cannot install, so no check waits forever", async () => {
    const inactive = Object.assign(fakeUpdater(), { isUpdaterActive: () => false });
    await expect(startWith(inactive, { platform: "linux" })).resolves.toBeNull();
    expect(inactive.on).not.toHaveBeenCalled();
    expect(inactive.checkForUpdates).not.toHaveBeenCalled();
    const active = Object.assign(fakeUpdater(), { isUpdaterActive: () => true });
    await expect(startWith(active, { platform: "linux" })).resolves.not.toBeNull();
  });

  // patches/electron-updater@6.8.9.patch: upstream asks again after a cancelled prompt and then reports success.
  it("installs a .deb under one password prompt and never lets apt-get remove a package", async () => {
    const { DebUpdater } = await import("electron-updater");
    const commands: string[][] = [];
    const cancelled = (command: string[]) => {
      commands.push(command);
      throw new Error("Command pkexec exited with code 126");
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(() =>
      DebUpdater.installWithCommandRunner("dpkg", "/tmp/dohc.deb", cancelled, logger),
    ).toThrow("126");
    expect(commands).toEqual([
      [
        "dpkg",
        "-i",
        "/tmp/dohc.deb",
        "||",
        "(",
        "apt-get",
        "install",
        "-f",
        "-y",
        "--no-remove",
        "&&",
        "dpkg",
        "-i",
        "/tmp/dohc.deb",
        ")",
      ],
    ]);
  });
});

describe("electron updater release without this platform's files", () => {
  // The Mac files join a release after the workflow publishes it.
  it("reports no update on macOS while the newest release has no Mac channel file", async () => {
    const updater = fakeUpdater();
    failChecksWith(updater, channelFileNotFound());
    const controller = await startWith(updater, {
      platform: "darwin",
      currentVersion: "0.1.1-nightly.20261018.41.1",
    });

    await expect(controller!.checkForUpdates()).resolves.toMatchObject({
      checked: true,
      state: { status: "up-to-date", canCheck: true },
    });
  });

  it("reports a missing channel file as an error on macOS for a custom feed", async () => {
    const updater = fakeUpdater();
    failChecksWith(updater, channelFileNotFound());
    const controller = await startWith(updater, {
      platform: "darwin",
      env: { DOHC_UPDATE_URL: "https://updates.example.test/dohc" },
    });

    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://updates.example.test/dohc",
    });
    await expect(controller!.checkForUpdates()).resolves.toMatchObject({
      checked: false,
      state: { status: "error", message: expect.stringContaining("Cannot find nightly-mac.yml") },
    });
  });
});

describe("electron updater actions", () => {
  it("on macOS, offers the download again when Squirrel cannot stage it", async () => {
    const updater = fakeUpdater();
    const controller = (await startWith(updater, { platform: "darwin" }))!;
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "1.2.4" });
    controller.downloadUpdate();
    updater.emit("update-downloaded", { version: "1.2.4" });
    const staging = new Error("Code signature at URL did not pass validation");
    // Squirrel's error, then the same error as the download's rejection.
    updater.emit("error", staging);
    updater.emit("error", staging);
    expect(controller.publicState()).toMatchObject({
      status: "available",
      message: expect.stringContaining("Code signature"),
      failure: { step: "download", id: 1 },
    });
    expect(controller.downloadUpdate().accepted).toBe(true);
  });

  // The latch is pulled once. A second request is not refused: refusing it
  // would strand the update whenever a recovery warning vetoed the first
  // restart's unload. The restart is not lost, because electron-updater
  // installs it on the next quit, so a second request completes it by
  // quitting. Main holds this fact, not a renderer module variable a reload
  // resets.
  it("on macOS, installs only after update-downloaded, pulls the latch once, and completes a staged restart", async () => {
    const updater = fakeUpdater();
    const app = fakeApp(updater);
    const controller = await startWith(updater, { app, platform: "darwin" });
    expect(controller).not.toBeNull();

    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: false,
    });

    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "1.2.4" });
    controller!.downloadUpdate();
    updater.emit("update-downloaded", { version: "1.2.4" });

    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: true,
    });
    expect(app.quit).not.toHaveBeenCalled();

    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: true,
    });
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(
      updater.quitAndInstall,
      "one-shot: drop the restartStaged branch so quitAndInstall runs again. electron-updater ignores it, and the app never quits.",
    ).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  // Windows' installer closes dohc by force about a second after it starts,
  // so it starts only once dohc has quit, and a window can still go back.
  describe("on Windows", () => {
    async function ready(options: { restartApproved?: () => boolean } = {}) {
      const updater = fakeUpdater();
      const app = fakeApp(updater);
      const controller = (await startWith(updater, { app, ...options }))!;
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "1.2.4" });
      controller.downloadUpdate();
      updater.emit("update-downloaded", { version: "1.2.4" });
      return { updater, app, controller };
    }

    it("quits on Restart to update, then starts the installer that opens dohc again", async () => {
      const { updater, app, controller } = await ready();
      await expect(controller.installUpdate()).resolves.toMatchObject({ accepted: true });
      expect(app.quit).toHaveBeenCalledOnce();
      expect(updater.install).not.toHaveBeenCalled();
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      await expect(controller.installUpdate()).resolves.toMatchObject({ accepted: true });
      expect(app.quit).toHaveBeenCalledTimes(2);
      expect(updater.install).not.toHaveBeenCalled();

      app.exit(0);
      expect(startedInstalls(updater)).toEqual([[false, true]]);
    });

    it("after a window goes back, a later quit installs without opening dohc again", async () => {
      let approved = true;
      const { updater, app, controller } = await ready({ restartApproved: () => approved });
      await controller.installUpdate();
      approved = false;
      app.exit(0);
      expect(startedInstalls(updater)).toEqual([[true, false]]);
    });

    it("installs on an ordinary quit as before, and nothing on an error exit", async () => {
      const ordinary = await ready();
      ordinary.app.exit(0);
      expect(startedInstalls(ordinary.updater)).toEqual([[true, false]]);

      const failed = await ready();
      await failed.controller.installUpdate();
      failed.app.exit(1);
      expect(failed.updater.install).not.toHaveBeenCalled();
    });
  });

  it("downloads only when a person asks, once", async () => {
    const updater = fakeUpdater();
    const controller = (await startWith(updater))!;
    expect(controller.downloadUpdate()).toMatchObject({
      accepted: false,
      state: { status: "idle" },
    });

    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "1.2.4" });
    expect(controller.publicState()).toMatchObject({
      status: "available",
      version: "1.2.4",
      message: "dohc 1.2.4 is available.",
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    await expect(controller.installUpdate()).resolves.toMatchObject({ accepted: false });
    updater.emit("update-downloaded", { version: "1.2.4" });
    expect(controller.publicState().status).toBe("available");

    expect(controller.downloadUpdate()).toMatchObject({
      accepted: true,
      state: { status: "downloading" },
    });
    expect(controller.downloadUpdate()).toMatchObject({ accepted: false });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    updater.emit("update-downloaded", { version: "1.2.4" });
    expect(controller.publicState()).toMatchObject({ status: "ready", canInstall: true });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("returns a failed download to Update, with the step that failed", async () => {
    for (const emits of [true, false]) {
      const updater = fakeUpdater();
      const controller = (await startWith(updater))!;
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "1.2.4" });
      updater.downloadUpdate.mockImplementationOnce(async () => {
        const error = new Error("sha512 checksum mismatch\nheaders");
        if (emits) updater.emit("error", error);
        throw error;
      });
      controller.downloadUpdate();
      await vi.waitFor(() =>
        expect(controller.publicState()).toMatchObject({
          status: "available",
          message: "sha512 checksum mismatch",
          failure: { step: "download" },
        }),
      );
      expect(controller.downloadUpdate().state).not.toHaveProperty("failure");
    }
  });

  it("toasts a background check failure once, and every failure a person asked for", async () => {
    const updater = fakeUpdater();
    failChecksWith(updater, new Error("feed returned 500"));
    const controller = (await startWith(updater))!;
    await controller.checkForUpdates();
    const first = controller.publicState().failure;
    expect(first).toMatchObject({ step: "check" });
    expect(controller.publicState().message).toBe("feed returned 500");
    await controller.checkForUpdates();
    expect(controller.publicState().failure).toEqual(first);
    await controller.checkForUpdates(true);
    const asked = controller.publicState().failure;
    expect(asked?.id).toBeGreaterThan(first!.id);
    failChecksWith(updater, new Error("feed returned 503"));
    await controller.checkForUpdates();
    expect(controller.publicState().failure?.id).toBeGreaterThan(asked!.id);
    failChecksWith(updater, new Error("net::ERR_INTERNET_DISCONNECTED"));
    await controller.checkForUpdates();
    expect(controller.publicState()).toMatchObject({ status: "offline" });
    expect(controller.publicState()).not.toHaveProperty("failure");
  });

  it("surfaces updater install error events while keeping the update retryable", async () => {
    const updater = fakeUpdater();
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit("error", new Error("quit failed"));
    });
    // Windows installs on the quit, and on macOS an error while ready is a failed staging.
    const controller = await startWith(updater, { platform: "linux" });
    expect(controller).not.toBeNull();

    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "1.2.4" });
    controller!.downloadUpdate();
    updater.emit("update-downloaded", { version: "1.2.4" });

    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: false,
      state: {
        status: "ready",
        canInstall: true,
        message: "quit failed",
        failure: { step: "install" },
      },
    });
  });

  it("on Linux says why a .deb did not install and gives the command that installs it", async () => {
    const deb = "/home/sam/.cache/dohc-updater/pending/dohc-1.2.4-linux-amd64.deb";
    const install = `sudo apt install '${deb}'`;
    // electron-updater's words for a failed install command (BaseUpdater.spawnSyncLog).
    for (const [error, message, installCommand] of [
      ["Command pkexec exited with code 126", "The update needs your password.", undefined],
      [
        "Command pkexec exited with code 127",
        "dohc did not get permission. Run this command in a terminal to install it.",
        install,
      ],
      ["Command sudo exited with code 1", "Run this command in a terminal to install it.", install],
      [
        "Command pkexec exited with code 1",
        "Run this command in a terminal to install it.",
        install,
      ],
    ] as const) {
      const updater = fakeUpdater();
      updater.quitAndInstall.mockImplementationOnce(() => updater.emit("error", new Error(error)));
      const controller = await startWith(updater, { platform: "linux" });
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "1.2.4", downloadedFile: deb });
      controller!.downloadUpdate();
      updater.emit("update-downloaded", { version: "1.2.4", downloadedFile: deb });

      const result = await controller!.installUpdate();
      expect(result, error).toMatchObject({
        accepted: false,
        reason: message,
        state: { status: "ready", canInstall: true, message },
      });
      expect(result.state.installCommand, error).toBe(installCommand);
      // electron-updater clears its one-shot latch after a failed install, so Restart tries again.
      await expect(controller!.installUpdate()).resolves.toMatchObject({ accepted: true });
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(2);
    }
  });

  it("quotes the .deb's path for the shell in the install command, and the update state carries the longest one", () => {
    expect(
      debInstallFailure(
        new Error("Command sudo exited with code 1"),
        "/home/o'brien/dohc 1.2.4.deb",
      ).installCommand,
    ).toBe("sudo apt install '/home/o'\\''brien/dohc 1.2.4.deb'");
    // A Linux path is at most 4,096 bytes; quoting makes each ' four characters.
    const longest = debInstallFailure(
      new Error("Command sudo exited with code 1"),
      `/${"'".repeat(4095)}`,
    ).installCommand;
    expect(
      UpdateStateEvent.parse({
        status: "ready",
        message: "Run this command in a terminal to install it.",
        installCommand: longest,
      }).installCommand,
    ).toBe(longest);
  });

  describe("awaitUpdate", () => {
    const bounds = { verdictMs: 15_000, downloadMs: 300_000 };
    const yes = async () => true;

    it("checks now and resolves with the version once it downloads", async () => {
      const updater = fakeUpdater();
      updater.checkForUpdates.mockImplementationOnce(async () => {
        updater.emit("checking-for-update");
        updater.emit("update-available", { version: "1.2.4" });
      });
      const controller = (await startWith(updater))!;
      const onDownloading = vi.fn();
      const answer = deferred<boolean>();
      const confirmDownload = vi.fn(() => answer.promise);
      const waiting = controller.awaitUpdate(bounds, confirmDownload, onDownloading);
      await vi.waitFor(() => expect(confirmDownload).toHaveBeenCalledWith("1.2.4"));
      expect(updater.downloadUpdate).not.toHaveBeenCalled();
      answer.resolve(true);
      await vi.waitFor(() => expect(controller.state().status).toBe("downloading"));
      expect(updater.downloadUpdate).toHaveBeenCalledOnce();
      expect(onDownloading).toHaveBeenCalledWith("1.2.4");
      updater.emit("download-progress", { percent: 50 });
      updater.emit("update-downloaded", { version: "1.2.4" });
      await expect(waiting).resolves.toBe("1.2.4");
      expect(updater.checkForUpdates).toHaveBeenCalledOnce();
      expect(onDownloading).toHaveBeenCalledOnce();
    });

    it("downloads nothing when the person declines", async () => {
      const updater = fakeUpdater();
      updater.checkForUpdates.mockImplementationOnce(async () => {
        updater.emit("checking-for-update");
        updater.emit("update-available", { version: "1.2.4" });
      });
      const controller = (await startWith(updater))!;
      await expect(controller.awaitUpdate(bounds, async () => false)).resolves.toBeNull();
      expect(updater.downloadUpdate).not.toHaveBeenCalled();
      expect(controller.state().status).toBe("available");
    });

    it("gives up on a silent feed at the verdict bound and on a stalled download at the download bound", async () => {
      vi.useFakeTimers();
      try {
        const silent = fakeUpdater();
        silent.checkForUpdates.mockImplementationOnce(async () => {
          silent.emit("checking-for-update");
        });
        const silentWait = (await startWith(silent))!.awaitUpdate(bounds, yes);
        await vi.advanceTimersByTimeAsync(bounds.verdictMs);
        await expect(silentWait).resolves.toBeNull();

        const stalled = fakeUpdater();
        stalled.checkForUpdates.mockImplementationOnce(async () => {
          stalled.emit("checking-for-update");
          stalled.emit("update-available", { version: "1.2.4" });
        });
        let result: string | null | undefined;
        void (await startWith(stalled))!.awaitUpdate(bounds, yes).then((version) => {
          result = version;
        });
        await vi.advanceTimersByTimeAsync(bounds.verdictMs);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(bounds.downloadMs - bounds.verdictMs);
        expect(result).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("electron updater after a quit", () => {
  function stateDir(): { stateDir: string; path: string } {
    const folder = mkdtempSync(join(tmpdir(), "dohc-chosen-update-"));
    onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
    return { stateDir: folder, path: join(folder, "chosen-update.json") };
  }
  const offer = (updater: ReturnType<typeof fakeUpdater>, version: string) => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version });
  };

  it("says a chosen update did not install when dohc opens on the same version, then downloads it again", async () => {
    const { stateDir: folder, path } = stateDir();
    const before = fakeUpdater();
    const first = (await startWith(before, { stateDir: folder, platform: "darwin" }))!;
    offer(before, "1.2.4");
    expect(existsSync(path)).toBe(false);
    first.downloadUpdate();
    // Quitting now installs it, so the choice is kept from the download on.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: "1.2.4", from: "1.2.3" });

    // ShipIt gave up after the quit, so dohc opens on 1.2.3 again.
    const after = fakeUpdater();
    const second = (await startWith(after, { stateDir: folder, platform: "darwin" }))!;
    expect(second.publicState()).not.toHaveProperty("failure");
    offer(after, "1.2.5");
    const state = second.publicState();
    expect(state).toMatchObject({
      status: "available",
      version: "1.2.5",
      message: "dohc is still on version 1.2.3.",
      failure: { step: "download", notInstalled: "1.2.4" },
    });
    expect(UpdateStateEvent.parse(state)).toEqual(state);
    expect(existsSync(path)).toBe(false);

    expect(second.downloadUpdate().state).not.toHaveProperty("failure");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: "1.2.5", from: "1.2.3" });
  });

  it("forgets a chosen update once dohc opens on another version, or the feed offers none", async () => {
    for (const [currentVersion, ending] of [
      ["1.2.4", "launch"],
      ["1.2.3", "not-available"],
    ] as const) {
      const { stateDir: folder, path } = stateDir();
      writeFileSync(path, JSON.stringify({ version: "1.2.4", from: "1.2.3" }));
      const updater = fakeUpdater();
      const controller = (await startWith(updater, { stateDir: folder, currentVersion }))!;
      if (ending === "not-available") {
        updater.emit("checking-for-update");
        updater.emit("update-not-available");
      }
      expect(existsSync(path)).toBe(false);
      offer(updater, "1.2.5");
      expect(controller.publicState()).toMatchObject({ status: "available" });
      expect(controller.publicState()).not.toHaveProperty("failure");
    }
  });

  it("on Linux, where quitting installs nothing, keeps the choice only from Restart to update", async () => {
    const { stateDir: folder, path } = stateDir();
    const updater = fakeUpdater();
    const controller = (await startWith(updater, { stateDir: folder, platform: "linux" }))!;
    offer(updater, "1.2.4");
    controller.downloadUpdate();
    updater.emit("update-downloaded", { version: "1.2.4" });
    expect(existsSync(path)).toBe(false);
    await controller.installUpdate();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: "1.2.4", from: "1.2.3" });
  });
});
