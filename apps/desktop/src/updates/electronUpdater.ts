import {
  initialUpdateState,
  transition,
  type UpdateEvent,
  type UpdateState,
} from "./updateMachine";

export const UPDATE_CHANNELS = ["latest", "nightly"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export type PublicUpdateState = {
  status: UpdateState["status"];
  message: string;
  currentVersion: string;
  channel: UpdateChannel;
  canCheck: boolean;
  canInstall: boolean;
  version?: string;
  percent?: number;
};

export type UpdateActionResult = {
  accepted: boolean;
  // Electron applies updates by quitting the current process, so the running
  // app can only report whether the restart handoff was accepted. The field is
  // reserved for future installers that can confirm completion before exit.
  completed: boolean;
  state: PublicUpdateState;
};

export type UpdateCheckResult = {
  checked: boolean;
  state: PublicUpdateState;
};

export type AutoUpdateController = {
  state: () => UpdateState;
  publicState: () => PublicUpdateState;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  installUpdate: () => Promise<UpdateActionResult>;
  // Re-runs quitAndInstall for an install the RENDERER blocked (its close
  // guard vetoed the unload while set-aside drafts existed). The
  // installInFlight gate exists to refuse double REQUESTS, not resumes —
  // a second installUpdate() would answer accepted:false and "Restart
  // anyway" would do nothing (#579 review, r9).
  resumeBlockedInstall: () => Promise<UpdateActionResult>;
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
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(eventName: "checking-for-update", listener: () => void): void;
  on(eventName: "update-available", listener: (info: { version: string }) => void): void;
  on(eventName: "update-not-available", listener: () => void): void;
  on(eventName: "download-progress", listener: (progress: { percent: number }) => void): void;
  on(eventName: "update-downloaded", listener: (info: { version: string }) => void): void;
  on(eventName: "before-quit-for-update", listener: () => void): void;
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

function shouldStartUpdates(
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
    installInFlight?: boolean;
  },
): PublicUpdateState {
  const canCheck =
    !options.checkInFlight &&
    !options.installInFlight &&
    (state.status === "idle" ||
      state.status === "up-to-date" ||
      state.status === "offline" ||
      state.status === "error");
  const canInstall = !options.installInFlight && state.status === "ready";
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
  onBeforeQuitForUpdate?: () => void;
  importUpdater?: () => Promise<UpdaterModuleLike>;
}): Promise<AutoUpdateController | null> {
  const env = options.env ?? process.env;
  if (!shouldStartUpdates(env, options.isPackaged)) return null;

  const imported =
    options.importUpdater
      ? await options.importUpdater()
      : ((await import("electron-updater")) as UpdaterModuleLike);
  const { autoUpdater } = imported.default ?? imported;
  const currentVersion = options.currentVersion ?? "0.0.0";
  const channel = options.channel ?? resolveUpdateChannel(currentVersion);

  let state = initialUpdateState;
  let checkInFlight = false;
  let installInFlight = false;
  let installErrorMessage: string | null = null;
  let stopped = false;
  const publicState = () => {
    const base = publicUpdateState(state, {
      currentVersion,
      channel,
      checkInFlight,
      installInFlight,
    });
    return installErrorMessage && state.status === "ready"
      ? { ...base, message: installErrorMessage }
      : base;
  };
  const dispatch = (event: UpdateEvent): void => {
    state = transition(state, event);
    options.onState?.(state, publicState());
  };

  autoUpdater.autoDownload = true;
  // The machine's ready-state contract: a downloaded update installs on quit
  // even if no UI surface ever asks for a restart.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.channel = channel;
  autoUpdater.allowPrerelease = channel === "nightly";
  autoUpdater.allowDowngrade = false;
  const feedOverride = updateFeedOverride(env, options.isPackaged);
  if (feedOverride) {
    if (!options.isPackaged) autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: "generic", url: feedOverride });
  }

  autoUpdater.on("checking-for-update", () => {
    installErrorMessage = null;
    checkInFlight = true;
    dispatch({ type: "check" });
  });
  autoUpdater.on("update-available", (info) =>
    dispatch({ type: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => {
    dispatch({ type: "not-available" });
    checkInFlight = false;
    options.onState?.(state, publicState());
  });
  autoUpdater.on("download-progress", (progress) =>
    dispatch({ type: "progress", percent: boundedPercent(progress.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    installErrorMessage = null;
    dispatch({ type: "downloaded", version: info.version });
    checkInFlight = false;
    options.onState?.(state, publicState());
  });
  autoUpdater.on("before-quit-for-update", () => {
    options.onBeforeQuitForUpdate?.();
  });
  autoUpdater.on("error", (error) => {
    if (installInFlight && state.status === "ready") {
      installInFlight = false;
      installErrorMessage = INSTALL_RESTART_FAILURE;
      options.onState?.(state, publicState());
      return;
    }
    checkInFlight = false;
    installInFlight = false;
    dispatch(
      OFFLINE_PATTERN.test(error.message)
        ? { type: "offline" }
        : { type: "error", message: error.message },
    );
  });

  const checkForUpdates = async (): Promise<UpdateCheckResult> => {
    if (
      stopped ||
      checkInFlight ||
      installInFlight ||
      state.status === "checking" ||
      state.status === "available" ||
      state.status === "downloading" ||
      state.status === "ready"
    ) {
      return { checked: false, state: publicState() };
    }
    checkInFlight = true;
    installErrorMessage = null;
    try {
      await autoUpdater.checkForUpdates();
      return { checked: true, state: publicState() };
    } catch (error) {
      // The updater emits "error"; if it does not, leave the app usable and
      // make the action visibly retryable.
      if (checkInFlight) {
        checkInFlight = false;
        const message =
          error instanceof Error ? error.message : "checkForUpdates failed";
        dispatch(
          OFFLINE_PATTERN.test(message)
            ? { type: "offline" }
            : { type: "error", message },
        );
      }
      return { checked: false, state: publicState() };
    }
  };

  const attemptQuitAndInstall = (): UpdateActionResult => {
    try {
      autoUpdater.quitAndInstall(false, true);
      if (installErrorMessage) {
        return { accepted: false, completed: false, state: publicState() };
      }
      return { accepted: true, completed: false, state: publicState() };
    } catch {
      installInFlight = false;
      installErrorMessage = INSTALL_RESTART_FAILURE;
      options.onState?.(state, publicState());
      return { accepted: false, completed: false, state: publicState() };
    }
  };

  const installUpdate = async (): Promise<UpdateActionResult> => {
    if (stopped || installInFlight || state.status !== "ready") {
      return { accepted: false, completed: false, state: publicState() };
    }
    installInFlight = true;
    installErrorMessage = null;
    options.onState?.(state, publicState());
    return attemptQuitAndInstall();
  };

  // The renderer's close guard can veto the unload this install started (a
  // beforeunload block while set-aside drafts exist). "Restart anyway" must
  // re-run quitAndInstall: the installInFlight gate above refuses double
  // requests, and a RESUME is not one (#579 review, r9). With no blocked
  // install to resume, this is an ordinary install request under the
  // ordinary gate.
  const resumeBlockedInstall = async (): Promise<UpdateActionResult> => {
    if (stopped || state.status !== "ready") {
      return { accepted: false, completed: false, state: publicState() };
    }
    if (!installInFlight) return installUpdate();
    installErrorMessage = null;
    return attemptQuitAndInstall();
  };

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
    installUpdate,
    resumeBlockedInstall,
    stop,
  };
}
