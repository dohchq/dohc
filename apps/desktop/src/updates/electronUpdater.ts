import {
  initialUpdateState,
  transition,
  type UpdateChannel,
  type UpdateEvent,
  type UpdateState,
} from "./updateMachine";

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
  checkForUpdates: () => Promise<UpdateCheckResult>;
  // Checks now, or joins the check already running. Resolves with the
  // downloaded version, or null when none downloads within the bounds.
  // onDownloading runs once, when the feed offers a version to download.
  awaitUpdate: (
    bounds: UpdateWaitBounds,
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
const INSTALL_RESTART_FAILURE = "Could not restart into the update.";

type InstallFailure = { message: string; installCommand?: string };

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
    return { message: "The update did not install without your password. Choose Restart to try again." };
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
  const message = error instanceof Error ? error.message : "checkForUpdates failed";
  return OFFLINE_PATTERN.test(message) ? { type: "offline" } : { type: "error", message };
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
    ...(state.status === "downloading" ? { percent: state.percent } : {}),
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
  let restartStaged = false;
  let installFailure: InstallFailure | null = null;
  // The downloaded .deb on Linux, which a failed install names in its command.
  let debInstaller: string | null = null;
  let stopped = false;
  const publicState = () => {
    const base = publicUpdateState(state, {
      currentVersion,
      channel,
      checkInFlight,
      restartStaged,
    });
    return installFailure && state.status === "ready"
      ? { ...base, ...installFailure }
      : base;
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

  autoUpdater.autoDownload = true;
  // The machine's ready-state contract on Windows and macOS: a downloaded
  // update installs on quit even if no UI surface ever asks for a restart.
  // On Linux an update installs only when the person asks: a .deb installs
  // with dpkg behind a password prompt, which must never appear while someone
  // closes the app. There the click installs at once, so a staged restart has
  // nothing left to install.
  autoUpdater.autoInstallOnAppQuit = platform !== "linux";
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
    installFailure = null;
    checkInFlight = true;
    dispatch({ type: "check" });
  });
  autoUpdater.on("update-available", (info) =>
    dispatch({ type: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => {
    dispatch({ type: "not-available" });
    checkInFlight = false;
    emit();
  });
  autoUpdater.on("download-progress", (progress) =>
    dispatch({ type: "progress", percent: boundedPercent(progress.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    installFailure = null;
    debInstaller = platform === "linux" && info.downloadedFile?.endsWith(".deb") ? info.downloadedFile : null;
    dispatch({ type: "downloaded", version: info.version });
    checkInFlight = false;
    emit();
  });
  autoUpdater.on("error", (error) => {
    if (restartStaged && state.status === "ready") {
      restartStaged = false;
      installFailure = debInstaller ? debInstallFailure(error, debInstaller) : { message: INSTALL_RESTART_FAILURE };
      emit();
      return;
    }
    checkInFlight = false;
    restartStaged = false;
    dispatch(checkFailure(error, macReleaseFeed));
  });

  const checkForUpdates = async (): Promise<UpdateCheckResult> => {
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
    installFailure = null;
    try {
      await autoUpdater.checkForUpdates();
      return { checked: true, state: publicState() };
    } catch (error) {
      // The updater emits "error"; if it does not, leave the app usable and
      // make the action visibly retryable. A check that found no update yet
      // still ran.
      const failure = checkFailure(error, macReleaseFeed);
      if (checkInFlight) {
        checkInFlight = false;
        dispatch(failure);
      }
      return { checked: failure.type === "not-available", state: publicState() };
    }
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
    installFailure = null;
    emit();
    try {
      autoUpdater.quitAndInstall(false, true);
      // The updater's error event sets it while quitAndInstall runs.
      const failure = installFailure as InstallFailure | null;
      if (failure) {
        return { accepted: false, reason: failure.message, state: publicState() };
      }
      return { accepted: true, state: publicState() };
    } catch {
      restartStaged = false;
      installFailure = { message: INSTALL_RESTART_FAILURE };
      emit();
      return { accepted: false, reason: INSTALL_RESTART_FAILURE, state: publicState() };
    }
  };

  const awaitUpdate = (
    bounds: UpdateWaitBounds,
    onDownloading?: (version: string) => void,
  ): Promise<string | null> =>
    new Promise((resolve) => {
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
        if (done) return;
        if (state.status === "ready") return finish(state.version);
        if (stopped) return finish(null);
        if (state.status === "available" || state.status === "downloading") {
          // The feed offered an update: the download gets its own bound.
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
    awaitUpdate,
    installUpdate,
    stop,
  };
}
