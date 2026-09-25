import { app, dialog } from "electron";
import { startAutoUpdates, type UpdateWaitBounds } from "../updates/electronUpdater";
import { createUpdateAfterFailure, FAILURE_UPDATE_BOUNDS } from "../updates/updateAfterFailure";
import { confirmRestartDialog, showDownloadingDialog } from "../updates/failureDialogs";
import type { LaunchFailure } from "./launchEntry";

// Before main loads, nothing is on screen until an update is found, so the
// feed gets less time to answer than it does after a visible failure.
const BEFORE_LAUNCH_BOUNDS: UpdateWaitBounds = { ...FAILURE_UPDATE_BOUNDS, verdictMs: 5_000 };

/**
 * The entry module's check, loaded only when it needs one. Resolves true
 * when it owns the exit: a restart into an update, or a quit it made.
 */
export async function checkForUpdateBeforeMain(failure: LaunchFailure): Promise<boolean> {
  // The entry already holds the single-instance lock, so no other process
  // downloads or installs at the same time.
  await app.whenReady();
  const controller = await startAutoUpdates({
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
  });
  // Declining a downloaded update quits: relaunching this build would race
  // the install that runs on quit.
  let declined = false;
  try {
    const restarting = await createUpdateAfterFailure({
      controller: async () => controller,
      showDownloading: (kind, version, signal) => showDownloadingDialog(dialog, kind, version, signal),
      confirmRestart: async (kind, version) => {
        declined = !(await confirmRestartDialog(dialog, kind, version));
        return !declined;
      },
      install: async () => controller ? await controller.installUpdate() : { accepted: false },
      bounds: failure === "unfinished-launch" ? BEFORE_LAUNCH_BOUNDS : FAILURE_UPDATE_BOUNDS,
    })(failure);
    if (restarting) return true;
    if (!declined) return false;
    app.quit();
    return true;
  } finally {
    controller?.stop();
  }
}
