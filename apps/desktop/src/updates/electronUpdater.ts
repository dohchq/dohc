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
  const publicState = () =>
    publicUpdateState(state, {
      currentVersion,
      channel,
      checkInFlight,
      installInFlight,
    });
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
    dispatch({ type: "downloaded", version: info.version });
    checkInFlight = false;
    options.onState?.(state, publicState());
  });
  autoUpdater.on("before-quit-for-update", () => {
    options.onBeforeQuitForUpdate?.();
  });
  autoUpdater.on("error", (error) => {
    dispatch(
      OFFLINE_PATTERN.test(error.message)
        ? { type: "offline" }
        : { type: "error", message: error.message },
    );
    checkInFlight = false;
    installInFlight = false;
    options.onState?.(state, publicState());
  });

  const checkForUpdates = async (): Promise<UpdateCheckResult> => {
    if (
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
    try {
      await autoUpdater.checkForUpdates();
      return { checked: true, state: publicState() };
    } catch {
      // The updater emits "error"; if it does not, leave the app usable and
      // make the action visibly retryable.
      checkInFlight = false;
      return { checked: false, state: publicState() };
    }
  };

  const installUpdate = async (): Promise<UpdateActionResult> => {
    if (installInFlight || state.status !== "ready") {
      return { accepted: false, completed: false, state: publicState() };
    }
    installInFlight = true;
    options.onState?.(state, publicState());
    try {
      options.onBeforeQuitForUpdate?.();
      autoUpdater.quitAndInstall(false, true);
      return { accepted: true, completed: false, state: publicState() };
    } catch (error) {
      installInFlight = false;
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : "quitAndInstall failed",
      });
      return { accepted: true, completed: false, state: publicState() };
    }
  };

  const scheduleCheck = (delayMs: number): void => {
    const timeout = setTimeout(() => {
      void checkForUpdates();
    }, delayMs);
    timeout.unref?.();
  };

  const pollIntervalMs =
    options.pollIntervalMs ?? (channel === "nightly" ? 15 * 60_000 : 4 * 60 * 60_000);
  scheduleCheck(options.startupDelayMs ?? 15_000);
  const interval = setInterval(() => {
    void checkForUpdates();
  }, pollIntervalMs);
  interval.unref?.();

  return { state: () => state, publicState, checkForUpdates, installUpdate };
}
