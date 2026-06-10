import {
  initialUpdateState,
  transition,
  type UpdateEvent,
  type UpdateState,
} from "./updateMachine";

// Thin wiring from electron-updater onto the pure update machine. Updates run
// ONLY in a packaged app with DOHC_UPDATE_URL set — a local/dev build never
// auto-updates. electron-updater is imported lazily so loading this module
// (e.g. from a test) pulls in nothing Electron-shaped.

function updateFeedUrl(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
  const url = env.DOHC_UPDATE_URL?.trim();
  return isPackaged && url ? url : null;
}

// Network-shaped failures map to the machine's offline branch; everything
// else is a real error.
const OFFLINE_PATTERN =
  /ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::/i;

export async function startAutoUpdates(options: {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  onState?: (state: UpdateState) => void;
}): Promise<{ state: () => UpdateState } | null> {
  const url = updateFeedUrl(options.env ?? process.env, options.isPackaged);
  if (!url) return null;

  type UpdaterModule = typeof import("electron-updater");
  // electron-updater is CJS; Node's ESM interop may hang the real exports off
  // `default` depending on how the lexer reads its lazy getters.
  const imported = (await import("electron-updater")) as UpdaterModule & {
    default?: UpdaterModule;
  };
  const { autoUpdater } = imported.default ?? imported;

  let state = initialUpdateState;
  const dispatch = (event: UpdateEvent): void => {
    state = transition(state, event);
    options.onState?.(state);
  };

  autoUpdater.autoDownload = true;
  // The machine's ready-state contract: a downloaded update installs on quit
  // even if no UI surface ever asks for a restart.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: "generic", url });

  autoUpdater.on("checking-for-update", () => dispatch({ type: "check" }));
  autoUpdater.on("update-available", (info) =>
    dispatch({ type: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => dispatch({ type: "not-available" }));
  autoUpdater.on("download-progress", (progress) =>
    dispatch({ type: "progress", percent: progress.percent }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    dispatch({ type: "downloaded", version: info.version }),
  );
  autoUpdater.on("error", (error) =>
    dispatch(
      OFFLINE_PATTERN.test(error.message)
        ? { type: "offline" }
        : { type: "error", message: error.message },
    ),
  );

  // Failures surface through the "error" listener above; updates must never
  // throw into the app boot path.
  await autoUpdater.checkForUpdates().catch(() => undefined);
  return { state: () => state };
}
