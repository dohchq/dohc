import { describe, expect, it, vi } from "vitest";
import {
  debInstallFailure,
  publicUpdateState,
  resolveUpdateChannel,
  startAutoUpdates,
  updateFeedOverride,
  type AutoUpdateController,
} from "./electronUpdater";
import { initialUpdateState, transition, type UpdateEvent } from "./updateMachine";
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
  let quitAndInstallLatched = false;
  updater.quitAndInstall.mockImplementation(() => {
    if (quitAndInstallLatched) return;
    quitAndInstallLatched = true;
    updater.emit("before-quit-for-update");
  });
  return updater;
}

async function startWith(updater: ReturnType<typeof fakeUpdater> & { isUpdaterActive?: () => boolean }, options: {
  isPackaged?: boolean;
  env?: NodeJS.ProcessEnv;
  currentVersion?: string;
  quitForStagedRestart?: () => void;
  platform?: NodeJS.Platform;
} = {}): Promise<AutoUpdateController | null> {
  return startAutoUpdates({
    isPackaged: options.isPackaged ?? true,
    env: options.env ?? {},
    currentVersion: options.currentVersion ?? "1.2.3",
    startupDelayMs: 60 * 60_000,
    pollIntervalMs: 60 * 60_000,
    quitForStagedRestart: options.quitForStagedRestart,
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
    new Error("Cannot find nightly-mac.yml in the latest release artifacts (https://github.com/dohchq/dohc/releases/download/v0.1.1-nightly.20261019.42.1/nightly-mac.yml): HttpError: 404"),
    { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" },
  );
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
    expect(updater.autoDownload).toBe(false);
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
    expect(() => DebUpdater.installWithCommandRunner("dpkg", "/tmp/dohc.deb", cancelled, logger)).toThrow("126");
    expect(commands).toEqual([[
      "dpkg", "-i", "/tmp/dohc.deb", "||",
      "(", "apt-get", "install", "-f", "-y", "--no-remove", "&&", "dpkg", "-i", "/tmp/dohc.deb", ")",
    ]]);
  });

  it("sets nightly channel flags explicitly", async () => {
    const updater = fakeUpdater();
    await startWith(updater, { currentVersion: "1.2.4-nightly.20260621.123" });

    expect(updater.channel).toBe("nightly");
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
  });
});

describe("electron updater release without this platform's files", () => {
  // The Mac files join a release after the workflow publishes it.
  it("reports no update on macOS while the newest release has no Mac channel file", async () => {
    const updater = fakeUpdater();
    failChecksWith(updater, channelFileNotFound());
    const controller = await startWith(updater, { platform: "darwin", currentVersion: "0.1.1-nightly.20261018.41.1" });

    await expect(controller!.checkForUpdates()).resolves.toMatchObject({
      checked: true,
      state: { status: "up-to-date", canCheck: true },
    });
  });

  it("reports a missing channel file as an error on Windows and Linux, whose files ship with the release", async () => {
    for (const platform of ["win32", "linux"] as const) {
      const updater = fakeUpdater();
      failChecksWith(updater, channelFileNotFound());
      const controller = await startWith(updater, { platform });

      await expect(controller!.checkForUpdates()).resolves.toMatchObject({
        checked: false,
        state: { status: "error", message: expect.stringContaining("Cannot find nightly-mac.yml") },
      });
    }
  });

  it("reports a missing channel file as an error on macOS for a custom feed", async () => {
    const updater = fakeUpdater();
    failChecksWith(updater, channelFileNotFound());
    const controller = await startWith(updater, { platform: "darwin", env: { DOHC_UPDATE_URL: "https://updates.example.test/dohc" } });

    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: "generic", url: "https://updates.example.test/dohc" });
    await expect(controller!.checkForUpdates()).resolves.toMatchObject({
      checked: false,
      state: { status: "error", message: expect.stringContaining("Cannot find nightly-mac.yml") },
    });
  });

  it("still reports other update errors on macOS", async () => {
    for (const error of [
      new Error("sha512 checksum mismatch"),
      Object.assign(new Error("Unable to find latest version on GitHub"), { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" }),
    ]) {
      const updater = fakeUpdater();
      failChecksWith(updater, error);
      const controller = await startWith(updater, { platform: "darwin" });

      await expect(controller!.checkForUpdates()).resolves.toMatchObject({
        checked: false,
        state: { status: "error", message: expect.stringContaining(error.message) },
      });
    }
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

  // The latch is pulled ONCE. What a second request means
  // changed in r18: it used to be refused, which stranded the update whenever
  // a recovery warning vetoed the first restart's unload. The restart is not
  // lost — electron-updater installs it on the next quit — so a second
  // request completes it by quitting, and this is MAIN's fact to hold, not a
  // renderer module variable a reload resets.
  it("installs only after update-downloaded, pulls the latch once, and completes a staged restart", async () => {
    const updater = fakeUpdater();
    const quitForStagedRestart = vi.fn();
    const controller = await startWith(updater, { quitForStagedRestart });
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
    expect(quitForStagedRestart).not.toHaveBeenCalled();

    await expect(controller!.installUpdate()).resolves.toMatchObject({
      accepted: true,
    });
    expect(quitForStagedRestart).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall, "one-shot: drop the restartStaged branch so quitAndInstall runs again. electron-updater ignores it, and the app never quits.").toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("bounds progress exposed to the renderer", async () => {
    const updater = fakeUpdater();
    const controller = await startWith(updater);
    expect(controller).not.toBeNull();

    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "1.2.4" });
    controller!.downloadUpdate();
    updater.emit("download-progress", { percent: 150 });

    expect(controller!.publicState()).toMatchObject({
      status: "downloading",
      percent: 100,
    });
  });

  it("downloads only when a person asks, once", async () => {
    const updater = fakeUpdater();
    const controller = (await startWith(updater))!;
    expect(controller.downloadUpdate()).toMatchObject({ accepted: false, state: { status: "idle" } });

    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "1.2.4" });
    expect(controller.publicState()).toMatchObject({ status: "available", version: "1.2.4", message: "dohc 1.2.4 is available." });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    // Nothing a download did not start can install.
    await expect(controller.installUpdate()).resolves.toMatchObject({ accepted: false });
    updater.emit("update-downloaded", { version: "1.2.4" });
    expect(controller.publicState().status).toBe("available");

    expect(controller.downloadUpdate()).toMatchObject({ accepted: true, state: { status: "downloading" } });
    expect(controller.downloadUpdate()).toMatchObject({ accepted: false });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    updater.emit("update-downloaded", { version: "1.2.4" });
    expect(controller.publicState()).toMatchObject({ status: "ready", canInstall: true });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("returns a failed download to Update, with the step that failed", async () => {
    // The updater emits "error" and rejects; a rejection alone still ends the download.
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
      await vi.waitFor(() => expect(controller.publicState()).toMatchObject({
        status: "available",
        message: "sha512 checksum mismatch",
        failure: { step: "download" },
      }));
      // Trying again clears the failure while it runs.
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
    // Offline is not a failure to report.
    failChecksWith(updater, new Error("net::ERR_INTERNET_DISCONNECTED"));
    await controller.checkForUpdates();
    expect(controller.publicState()).toMatchObject({ status: "offline" });
    expect(controller.publicState()).not.toHaveProperty("failure");
  });

  it("reports quitAndInstall failures as rejected restart requests", async () => {
    const updater = fakeUpdater();
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error("quit failed");
    });
    const controller = await startWith(updater);
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

  it("surfaces updater install error events while keeping the update retryable", async () => {
    const updater = fakeUpdater();
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit("error", new Error("quit failed"));
    });
    const controller = await startWith(updater);
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
      ["Command pkexec exited with code 126", "The update did not install without your password.", undefined],
      ["Command pkexec exited with code 127", "dohc did not get permission to install the update. Run this command in a terminal to install it.", install],
      ["Command sudo exited with code 1", "The update did not install. Run this command in a terminal to install it.", install],
      ["Command pkexec exited with code 1", "The update did not install. Run this command in a terminal to install it.", install],
    ] as const) {
      const updater = fakeUpdater();
      updater.quitAndInstall.mockImplementationOnce(() => updater.emit("error", new Error(error)));
      const controller = await startWith(updater, { platform: "linux" });
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "1.2.4", downloadedFile: deb });
      controller!.downloadUpdate();
      updater.emit("update-downloaded", { version: "1.2.4", downloadedFile: deb });

      const result = await controller!.installUpdate();
      expect(result, error).toMatchObject({ accepted: false, reason: message, state: { status: "ready", canInstall: true, message } });
      expect(result.state.installCommand, error).toBe(installCommand);
      // electron-updater clears its one-shot latch after a failed install, so Restart tries again.
      await expect(controller!.installUpdate()).resolves.toMatchObject({ accepted: true });
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(2);
    }
  });

  it("keeps the generic install failure for a Linux AppImage and on Windows", async () => {
    for (const [platform, downloadedFile] of [["linux", "/home/sam/dohc-1.2.4-linux-x86_64.AppImage"], ["win32", "C:/Users/sam/dohc-1.2.4.exe"]] as const) {
      const updater = fakeUpdater();
      updater.quitAndInstall.mockImplementationOnce(() => updater.emit("error", new Error("Command pkexec exited with code 127")));
      const controller = await startWith(updater, { platform });
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "1.2.4", downloadedFile });
      controller!.downloadUpdate();
      updater.emit("update-downloaded", { version: "1.2.4", downloadedFile });

      const result = await controller!.installUpdate();
      const cause = "Command pkexec exited with code 127";
      expect(result, platform).toMatchObject({ accepted: false, reason: cause, state: { message: cause, failure: { step: "install" } } });
      expect(result.state.installCommand, platform).toBeUndefined();
    }
  });

  it("quotes the .deb's path for the shell in the install command, and the update state carries the longest one", () => {
    expect(debInstallFailure(new Error("Command sudo exited with code 1"), "/home/o'brien/dohc 1.2.4.deb").installCommand)
      .toBe("sudo apt install '/home/o'\\''brien/dohc 1.2.4.deb'");
    // A Linux path is at most 4,096 bytes; quoting makes each ' four characters.
    const longest = debInstallFailure(new Error("Command sudo exited with code 1"), `/${"'".repeat(4095)}`).installCommand;
    expect(UpdateStateEvent.parse({ status: "ready", message: "The update did not install.", installCommand: longest }).installCommand).toBe(longest);
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
      // Nothing downloads until the person answers.
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

    it.each([
      ["no update", (updater: ReturnType<typeof fakeUpdater>) => updater.emit("update-not-available")],
      ["offline", (updater: ReturnType<typeof fakeUpdater>) => updater.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"))],
      ["a failed download", (updater: ReturnType<typeof fakeUpdater>) => {
        updater.emit("update-available", { version: "1.2.4" });
        updater.emit("error", new Error("sha512 checksum mismatch"));
      }],
    ])("resolves null on %s", async (_name, answer) => {
      const updater = fakeUpdater();
      updater.checkForUpdates.mockImplementationOnce(async () => {
        updater.emit("checking-for-update");
        answer(updater);
      });
      const controller = (await startWith(updater))!;
      await expect(controller.awaitUpdate(bounds, yes)).resolves.toBeNull();
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

    it("joins a download the person already started without asking again", async () => {
      const updater = fakeUpdater();
      const controller = (await startWith(updater))!;
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "1.2.4" });
      controller.downloadUpdate();
      const confirmDownload = vi.fn(yes);
      const waiting = controller.awaitUpdate(bounds, confirmDownload);
      updater.emit("update-downloaded", { version: "1.2.4" });
      await expect(waiting).resolves.toBe("1.2.4");
      expect(confirmDownload).not.toHaveBeenCalled();
      expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    });

    it("resolves at once with an update already downloaded", async () => {
      const updater = fakeUpdater();
      const controller = (await startWith(updater))!;
      updater.emit("checking-for-update");
      updater.emit("update-available", { version: "1.2.4" });
      controller.downloadUpdate();
      updater.emit("update-downloaded", { version: "1.2.4" });
      await expect(controller.awaitUpdate(bounds, yes)).resolves.toBe("1.2.4");
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });

    it("joins a check that is already running", async () => {
      const updater = fakeUpdater();
      const controller = (await startWith(updater))!;
      updater.emit("checking-for-update");
      const waiting = controller.awaitUpdate(bounds, yes);
      updater.emit("update-available", { version: "1.2.4" });
      await vi.waitFor(() => expect(controller.state().status).toBe("downloading"));
      updater.emit("update-downloaded", { version: "1.2.4" });
      await expect(waiting).resolves.toBe("1.2.4");
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });

    it("gives up on a silent feed at the verdict bound and on a stalled download at the download bound", async () => {
      vi.useFakeTimers();
      try {
        const silent = fakeUpdater();
        silent.checkForUpdates.mockImplementationOnce(async () => { silent.emit("checking-for-update"); });
        const silentWait = (await startWith(silent))!.awaitUpdate(bounds, yes);
        await vi.advanceTimersByTimeAsync(bounds.verdictMs);
        await expect(silentWait).resolves.toBeNull();

        const stalled = fakeUpdater();
        stalled.checkForUpdates.mockImplementationOnce(async () => {
          stalled.emit("checking-for-update");
          stalled.emit("update-available", { version: "1.2.4" });
        });
        let result: string | null | undefined;
        void (await startWith(stalled))!.awaitUpdate(bounds, yes).then((version) => { result = version; });
        await vi.advanceTimersByTimeAsync(bounds.verdictMs);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(bounds.downloadMs - bounds.verdictMs);
        expect(result).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
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
  const READY_EVENTS: UpdateEvent[] = [
    { type: "check" },
    { type: "available", version: "1.0.1" },
    { type: "download" },
    { type: "downloaded", version: "1.0.1" },
  ];

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
    const ready = READY_EVENTS.reduce(transition, initialUpdateState);

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

  // quitAndInstall's latch never clears, so gating install on
  // it stranded a ready update for the rest of the run whenever the restart
  // was interrupted — a recovery warning whose "Go back" had nothing to go
  // back to. The restart is not lost; it is finishable by quitting.
  it("keeps a staged restart offerable while blocking a new check", () => {
    const ready = READY_EVENTS.reduce(transition, initialUpdateState);

    expect(
      publicUpdateState(ready, {
        currentVersion: "1.0.0",
        channel: "latest",
        restartStaged: true,
      }),
      "staged restart offerable: gate canInstall on restartStaged again. The Restart button disappears for the rest of the app run.",
    ).toMatchObject({
      status: "ready",
      canInstall: true,
      // ...but staging is done, so there is nothing to re-check for.
      canCheck: false,
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
