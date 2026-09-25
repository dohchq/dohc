// Electron's main entry. It stays small so that a bad main module, or a main
// that closes before it finishes starting, still reaches a newer build. See
// launch/launchEntry.ts for the policy.
import { app, dialog } from "electron";
import { join } from "node:path";
import { LAUNCH_CHECKED_FLAG, runLaunchEntry } from "./launch/launchEntry";
import { beginLaunch, LAUNCH_MARKER_FILE } from "./launch/launchMarker";
import { updatesEnabled } from "./updates/electronUpdater";

await runLaunchEntry({
  argv: process.argv,
  markerPath: updatesEnabled(process.env, app.isPackaged)
    ? join(app.getPath("userData"), LAUNCH_MARKER_FILE)
    : null,
  beginLaunch: (path) => beginLaunch(path, app.getVersion()),
  // Awaited, so main's pre-ready work runs before Electron is ready.
  loadMain: () => import("./main"),
  reportFailure: (error) => {
    console.error("[desktop] Desktop main failed to load:", error);
    const message = error instanceof Error ? error.message : "Unknown desktop startup error.";
    dialog.showErrorBox(
      "dohc failed to start",
      `${message}\n\nRestart dohc. If it fails again, review the desktop logs.`,
    );
  },
  checkForUpdate: async (failure) => {
    const { checkForUpdateBeforeMain } = await import("./launch/launchRecovery");
    return await checkForUpdateBeforeMain(failure);
  },
  quit: () => app.quit(),
  relaunchChecked: () => {
    app.relaunch({ args: [...process.argv.slice(1), LAUNCH_CHECKED_FLAG] });
    app.exit(0);
  },
});
