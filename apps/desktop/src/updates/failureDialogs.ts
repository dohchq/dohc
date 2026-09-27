import type { Dialog } from "electron";
import type { UpdateFailure } from "./updateAfterFailure";

type MessageDialog = Pick<Dialog, "showMessageBox">;

// What went wrong, for every failure but a failed startup, which already
// showed its own error.
const FAILURE_MESSAGES: Record<Exclude<UpdateFailure, "startup">, string> = {
  "window-crash": "This dohc window keeps crashing.",
  "window-load": "This dohc window could not load.",
  "unfinished-launch": "dohc closed before it finished starting.",
};

/**
 * Downloads can take minutes with nothing else on screen, so a native box
 * says one is running. It closes when the signal aborts. Closing it by hand
 * stops the wait.
 */
export async function showDownloadingDialog(
  dialog: MessageDialog,
  failure: UpdateFailure,
  version: string,
  signal: AbortSignal,
): Promise<void> {
  await dialog.showMessageBox({
    type: "info",
    message: failure === "startup" ? `Downloading update ${version}.` : FAILURE_MESSAGES[failure],
    detail: failure === "startup"
      ? "When it finishes, you can restart dohc on the new version."
      : `dohc is downloading update ${version}. When it finishes, you can restart dohc on the new version.`,
    buttons: [failure === "startup" ? "Quit" : "Not now"],
    noLink: true,
    signal,
  });
}

/**
 * Asks once whether to restart into the downloaded update. Before main runs,
 * the other choice is to quit; a window failure can wait.
 */
export async function confirmRestartDialog(
  dialog: MessageDialog,
  failure: UpdateFailure,
  version: string,
): Promise<boolean> {
  const quits = failure === "startup" || failure === "unfinished-launch";
  // A downloaded update also installs on quit (autoInstallOnAppQuit).
  const onQuit = "If you quit, the update installs as dohc closes.";
  const { response } = await dialog.showMessageBox({
    type: "info",
    message: failure === "startup" ? `Update ${version} is downloaded.` : FAILURE_MESSAGES[failure],
    detail: failure === "startup"
      ? `Restart now to open dohc on the new version. ${onQuit}`
      : quits
        ? `Update ${version} is downloaded. Restart now to open dohc on the new version. ${onQuit}`
        : `Update ${version} is downloaded. dohc closes and opens again on the new version.`,
    buttons: ["Restart now", quits ? "Quit" : "Not now"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}
