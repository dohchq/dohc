import {
  initialUpdateState,
  transition,
  type UpdateChannel,
  type UpdateEvent,
  type UpdateState,
} from "./updateMachine";

// The step a failure stopped, which Try again runs again.
export type UpdateStep = "check" | "download" | "install";

export type PublicUpdateState = {
  status: UpdateState["status"];
  message: string;
  currentVersion: string;
  channel: UpdateChannel;
  canCheck: boolean;
  canInstall: boolean;
  version?: string;
  percent?: number;
  // A Linux .deb that did not install: the command that installs it from a terminal.
  installCommand?: string;
  // The last step that failed, while its state stands. `message` says why. A
  // new id is a new failure to report.
  failure?: { step: UpdateStep; id: number };
};

export type UpdateActionResult = {
  accepted: boolean;
  // Why an install did not go ahead, when the updater said.
  reason?: string;
  state: PublicUpdateState;
};

export type UpdateCheckResult = {
  checked: boolean;
  state: PublicUpdateState;
};

// How long a failing app waits for an update: first for the feed to answer,
// then for an update it found to download.
export type UpdateWaitBounds = {
  verdictMs: number;
  downloadMs: number;
};

export type AutoUpdateController = {
  state: () => UpdateState;
  publicState: () => PublicUpdateState;
  // requested: a person asked, so even a failure like the last one is news.
  checkForUpdates: (requested?: boolean) => Promise<UpdateCheckResult>;
  // Starts downloading the available update. Progress, the result and a
  // failure arrive as state.
  downloadUpdate: () => UpdateActionResult;
  // Checks now, or joins the check already running. When the feed offers an
  // update, nothing downloads until confirmDownload resolves true; a download
  // a person already started is joined without asking. Resolves with the
  // downloaded version, or null when the person declines or none downloads
  // within the bounds. onDownloading runs once, when the download starts.
  awaitUpdate: (
    bounds: UpdateWaitBounds,
    confirmDownload: (version: string) => Promise<boolean>,
    onDownloading?: (version: string) => void,
  ) => Promise<string | null>;
  installUpdate: () => Promise<UpdateActionResult>;
  stop: () => void;
};

type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel?: string;
  allowPrerelease?: boolean;
  allowDowngrade?: boolean;
  forceDevUpdateConfig?: boolean;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  // False where this updater cannot install, such as a Linux build that is
  // neither an AppImage nor a package. Its checks then resolve without events.
  isUpdaterActive?(): boolean;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(eventName: "checking-for-update", listener: () => void): void;
  on(eventName: "update-available", listener: (info: { version: string }) => void): void;
  on(eventName: "update-not-available", listener: () => void): void;
  on(eventName: "download-progress", listener: (progress: { percent: number }) => void): void;
  on(eventName: "update-downloaded", listener: (info: { version: string; downloadedFile?: string }) => void): void;
  on(eventName: "error", listener: (error: Error) => void): void;
};

type UpdaterModuleLike = {
  autoUpdater: AutoUpdaterLike;
  default?: { autoUpdater: AutoUpdaterLike };
};

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+(?:\.\d+)?$/;

export function resolveUpdateChannel(version: string): UpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(version) ? "nightly" : "latest";
}

export function updateFeedOverride(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
): string | null {
  const url = env.DOHC_UPDATE_URL?.trim();
  if (!url) return null;
  if (isPackaged) return url;
  return env.DOHC_DESKTOP_MOCK_UPDATES === "1" ? url : null;
}

// Whether this build runs an updater at all: packaged, or pointed at a mock
// feed in development.
export function updatesEnabled(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
): boolean {
  return isPackaged || updateFeedOverride(env, isPackaged) !== null;
}

// Network-shaped failures map to the machine's offline branch; everything
// else is a real error.
const OFFLINE_PATTERN =
  /ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::/i;

// Whether quitting dohc installs an update the person downloaded, as well as
// Restart to update. Never on Linux: a .deb installs with dpkg behind a
// password prompt, which must never appear while someone closes the app.
const INSTALL_ON_QUIT = true;

export function installsOnQuit(platform: NodeJS.Platform): boolean {
  return INSTALL_ON_QUIT && platform !== "linux";
}

type InstallFailure = { message: string; installCommand?: string };

// Each failure shows while the state it left stands: a failed check leaves
// "error", a failed download "available", and a failed install "ready".
const FAILED_STATUS = { check: "error", download: "available", install: "ready" } as const;

/**
 * Why a Linux .deb did not install, and what the person can do. electron-updater installs it as root
 * through the first of gksudo, kdesudo, pkexec, and beesu it finds, or plain sudo, and reports a
 * failure as "Command <program> exited with code <status>". pkexec exits 126 when the person closes
 * its prompt, and 127 when it gets no authorization any other way: no agent to ask, a refusal, or
 * an error. Plain sudo has no terminal to ask from, and its failure looks like dpkg's, so its cause
 * stays unnamed.
 */
export function debInstallFailure(error: Error, installer: string): InstallFailure {
  const [, program, status] = /^Command (\S+) exited with code (\d+)$/u.exec(error.message) ?? [];
  if (program === "pkexec" && status === "126") {
    return { message: "The update did not install without your password." };
  }
  const installCommand = `sudo apt install '${installer.replaceAll("'", "'\\''")}'`;
  return program === "pkexec" && status === "127"
    ? { message: "dohc did not get permission to install the update. Run this command in a terminal to install it.", installCommand }
    : { message: "The update did not install. Run this command in a terminal to install it.", installCommand };
}
// electron-updater's code when the feed has no channel file for this
// platform. GitHubProvider sets it on a 404 for <channel>-mac.yml in the
// newest release; GenericProvider sets it for a custom feed.
const CHANNEL_FILE_NOT_FOUND = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";

// What a failed check means for the person. The Mac files join a GitHub
// release after the workflow publishes it (docs/engineering/desktop-release.md),
// so until then a Mac finds no channel file there: no update yet, not a
// failure. Windows and Linux files ship with the release, and a custom feed
// has no such gap, so for them it means a broken feed.
function checkFailure(error: unknown, macReleaseFeed: boolean): UpdateEvent {
  if (macReleaseFeed && error instanceof Error && "code" in error && error.code === CHANNEL_FILE_NOT_FOUND) {
    return { type: "not-available" };
  }
  const message = causeOf(error);
  return OFFLINE_PATTERN.test(message) ? { type: "offline" } : { type: "error", message };
}

// The updater's reason as one line that fits the IPC contract. An HTTP
// error carries its response headers on the lines after the first.
function causeOf(error: unknown): string {
  const line = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
  return (line || "The updater gave no reason.").slice(0, 500);
}

function boundedPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

export function publicUpdateState(
  state: UpdateState,
  options: {
    currentVersion: string;
    channel: UpdateChannel;
    checkInFlight?: boolean;
    restartStaged?: boolean;
  },
): PublicUpdateState {
  const canCheck =
    !options.checkInFlight &&
    !options.restartStaged &&
    (state.status === "idle" ||
      state.status === "up-to-date" ||
      state.status === "offline" ||
      state.status === "error");
  // A staged restart is still offerable. `restartStaged`
  // latches once quitAndInstall runs and never clears, so gating on it stranded
  // the update for the rest of the run whenever the restart was interrupted —
  // a late recovery warning whose "Go back" then had nothing to go back to.
  // The restart is not lost: electron-updater installs it on the next quit
  // (on Linux, quitAndInstall already installed it), and the renderer
  // finishes the staged one by resuming that quit.
  const canInstall = state.status === "ready";
  return {
    status: state.status,
    message: state.message,
    currentVersion: options.currentVersion,
    channel: options.channel,
    canCheck,
    canInstall,
    ...("version" in state ? { version: state.version } : {}),
    ...(state.status === "downloading" && state.percent !== undefined ? { percent: state.percent } : {}),
  };
}

export async function startAutoUpdates(options: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  currentVersion?: string;
  channel?: UpdateChannel;
  startupDelayMs?: number;
  pollIntervalMs?: number;
  onState?: (state: UpdateState, publicState: PublicUpdateState) => void;
  // Completes a restart that was already staged. quitAndInstall starts its
  // own quit on the first call and has none left to start on a second, so
  // main makes it.
  quitForStagedRestart?: () => void;
  importUpdater?: () => Promise<UpdaterModuleLike>;
  platform?: NodeJS.Platform;
}): Promise<AutoUpdateController | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (!updatesEnabled(env, options.isPackaged)) return null;

  const imported =
    options.importUpdater
      ? await options.importUpdater()
      : ((await import("electron-updater")) as UpdaterModuleLike);
  const { autoUpdater } = imported.default ?? imported;
  const currentVersion = options.currentVersion ?? "0.0.0";
  const channel = options.channel ?? resolveUpdateChannel(currentVersion);

  let state = initialUpdateState;
  let checkInFlight = false;
  let checkRequested = false;
  let restartStaged = false;
  let failure: (InstallFailure & { step: UpdateStep; id: number }) | null = null;
  let failures = 0;
  // The downloaded .deb on Linux, which a failed install names in its command.
  let debInstaller: string | null = null;
  // electron-updater reports a failed macOS staging twice: as Squirrel's
  // error, then as the download's rejection.
  let stagingError: unknown = null;
  let stopped = false;
  const publicState = (): PublicUpdateState => {
    const base = publicUpdateState(state, {
      currentVersion,
      channel,
      checkInFlight,
      restartStaged,
    });
    if (!failure || FAILED_STATUS[failure.step] !== state.status) return base;
    const { step, id, message, installCommand } = failure;
    return { ...base, message, failure: { step, id }, ...(installCommand ? { installCommand } : {}) };
  };
  // A background check that fails as the last one did keeps that failure,
  // so its row updates without a new toast. Anything a person asked for is
  // a new failure.
  const fail = (step: UpdateStep, cause: InstallFailure, requested: boolean): void => {
    if (!requested && failure?.step === step && failure.message === cause.message) return;
    failures += 1;
    failure = { ...cause, step, id: failures };
  };
  const waiters = new Set<() => void>();
  const emit = (): void => {
    options.onState?.(state, publicState());
    for (const waiter of [...waiters]) waiter();
  };
  const dispatch = (event: UpdateEvent): void => {
    state = transition(state, event);
    emit();
  };
  const downloadFailed = (error: unknown): void => {
    if (state.status !== "downloading") return;
    fail("download", { message: causeOf(error) }, true);
    dispatch({ type: "error", message: causeOf(error) });
  };

  // Nothing downloads until a person chooses Update.
  autoUpdater.autoDownload = false;
  // On Linux the click installs at once, so a staged restart has nothing
  // left to install.
  autoUpdater.autoInstallOnAppQuit = installsOnQuit(platform);
  autoUpdater.channel = channel;
  autoUpdater.allowPrerelease = channel === "nightly";
  autoUpdater.allowDowngrade = false;
  const feedOverride = updateFeedOverride(env, options.isPackaged);
  const macReleaseFeed = platform === "darwin" && feedOverride === null;
  if (feedOverride) {
    if (!options.isPackaged) autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: "generic", url: feedOverride });
  }
  if (autoUpdater.isUpdaterActive?.() === false) return null;

  autoUpdater.on("checking-for-update", () => {
    checkInFlight = true;
    dispatch({ type: "check" });
  });
  autoUpdater.on("update-available", (info) => {
    failure = null;
    dispatch({ type: "available", version: info.version });
    checkInFlight = false;
    emit();
  });
  autoUpdater.on("update-not-available", () => {
    failure = null;
    dispatch({ type: "not-available" });
    checkInFlight = false;
    emit();
  });
  autoUpdater.on("download-progress", (progress) =>
    dispatch({ type: "progress", percent: boundedPercent(progress.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    failure = null;
    debInstaller = platform === "linux" && info.downloadedFile?.endsWith(".deb") ? info.downloadedFile : null;
    dispatch({ type: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (error) => {
    if (error === stagingError) return;
    if (platform === "darwin" && state.status === "ready") {
      // electron-updater reports a macOS download before Squirrel stages it.
      // A failed staging leaves nothing to install, so the update downloads
      // again, which stages it again.
      stagingError = error;
      restartStaged = false;
      fail("download", { message: causeOf(error) }, true);
      dispatch({ type: "unstaged" });
      return;
    }
    if (restartStaged && state.status === "ready") {
      restartStaged = false;
      fail("install", debInstaller ? debInstallFailure(error, debInstaller) : { message: causeOf(error) }, true);
      emit();
      return;
    }
    if (state.status === "downloading") return downloadFailed(error);
    checkInFlight = false;
    restartStaged = false;
    const event = checkFailure(error, macReleaseFeed);
    if (event.type === "error") fail("check", { message: event.message }, checkRequested);
    else failure = null;
    dispatch(event);
  });

  const checkForUpdates = async (requested = false): Promise<UpdateCheckResult> => {
    if (
      stopped ||
      checkInFlight ||
      restartStaged ||
      state.status === "checking" ||
      state.status === "available" ||
      state.status === "downloading" ||
      state.status === "ready"
    ) {
      return { checked: false, state: publicState() };
    }
    checkInFlight = true;
    checkRequested = requested;
    try {
      await autoUpdater.checkForUpdates();
      return { checked: true, state: publicState() };
    } catch (error) {
      // The updater emits "error"; if it does not, leave the app usable and
      // make the action visibly retryable. A check that found no update yet
      // still ran.
      const event = checkFailure(error, macReleaseFeed);
      if (checkInFlight) {
        checkInFlight = false;
        if (event.type === "error") fail("check", { message: event.message }, requested);
        else failure = null;
        dispatch(event);
      }
      return { checked: event.type === "not-available", state: publicState() };
    }
  };

  const downloadUpdate = (): UpdateActionResult => {
    if (stopped || state.status !== "available") {
      return { accepted: false, state: publicState() };
    }
    failure = null;
    dispatch({ type: "download" });
    // The updater's error event reports a failure first; this covers one it
    // never emitted, so the download cannot stay running forever.
    autoUpdater.downloadUpdate().catch(downloadFailed);
    return { accepted: true, state: publicState() };
  };

  // quitAndInstall is ONE-SHOT in electron-updater: a second call returns
  // without quitting. Every recovery decision therefore happens before this
  // runs (the renderer checks its set-aside drafts first, and main
  // pre-approves the quit) — there is deliberately no resume path here.
  const installUpdate = async (): Promise<UpdateActionResult> => {
    if (stopped || state.status !== "ready") {
      return { accepted: false, state: publicState() };
    }
    if (restartStaged) {
      // The latch is spent, but the restart is not lost: electron-updater
      // installs it on the next quit (on Linux, the spent call already
      // installed it). What remains is exactly that quit, and
      // it is MAIN's to make. The renderer must not have
      // to know — it held this fact in a module variable, which a reload
      // reset while this latch stayed set, stranding the update for the rest
      // of the run.
      options.quitForStagedRestart?.();
      return { accepted: true, state: publicState() };
    }
    restartStaged = true;
    failure = null;
    emit();
    try {
      autoUpdater.quitAndInstall(false, true);
      // The updater's error event sets it while quitAndInstall runs.
      const failed = failure as InstallFailure | null;
      if (failed) {
        return { accepted: false, reason: failed.message, state: publicState() };
      }
      return { accepted: true, state: publicState() };
    } catch (error) {
      restartStaged = false;
      fail("install", { message: causeOf(error) }, true);
      emit();
      return { accepted: false, reason: causeOf(error), state: publicState() };
    }
  };

  const awaitUpdate = (
    bounds: UpdateWaitBounds,
    confirmDownload: (version: string) => Promise<boolean>,
    onDownloading?: (version: string) => void,
  ): Promise<string | null> =>
    new Promise((resolve) => {
      let asked = false;
      let asking = false;
      let downloading = false;
      let done = false;
      let timer = setTimeout(() => finish(null), bounds.verdictMs);
      function finish(version: string | null): void {
        done = true;
        clearTimeout(timer);
        waiters.delete(settle);
        resolve(version);
      }
      function settle(): void {
        if (done || asking) return;
        if (state.status === "ready") return finish(state.version);
        if (stopped) return finish(null);
        if (state.status === "available" && !asked) {
          // The answer has no bound: the person decides, not the feed.
          asked = asking = true;
          clearTimeout(timer);
          void confirmDownload(state.version).then((accepted) => {
            asking = false;
            if (!accepted) return finish(null);
            downloadUpdate();
            settle();
          }, () => finish(null));
          return;
        }
        if (state.status === "downloading") {
          // The download gets its own bound.
          if (downloading) return;
          downloading = true;
          clearTimeout(timer);
          timer = setTimeout(() => finish(null), bounds.downloadMs);
          onDownloading?.(state.version);
          return;
        }
        if (!checkInFlight && state.status !== "checking") finish(null);
      }
      waiters.add(settle);
      void checkForUpdates().then(settle);
    });

  const scheduleCheck = (delayMs: number): ReturnType<typeof setTimeout> => {
    const timeout = setTimeout(() => {
      void checkForUpdates();
    }, delayMs);
    timeout.unref?.();
    return timeout;
  };

  const pollIntervalMs =
    options.pollIntervalMs ?? (channel === "nightly" ? 15 * 60_000 : 4 * 60 * 60_000);
  const startupTimeout = scheduleCheck(options.startupDelayMs ?? 15_000);
  const interval = setInterval(() => {
    void checkForUpdates();
  }, pollIntervalMs);
  interval.unref?.();

  const stop = (): void => {
    stopped = true;
    clearTimeout(startupTimeout);
    clearInterval(interval);
  };

  return {
    state: () => state,
    publicState,
    checkForUpdates,
    downloadUpdate,
    awaitUpdate,
    installUpdate,
    stop,
  };
}
