import { useEffect } from "react";
import { bridge } from "./bridge";
import { requestGuardedUpdateInstall } from "./RecoveryCloseGuard";
import { toggleTheme } from "./theme";

type ReportError = (message: string, error: unknown) => void;

// The update commands, the same in every window, with or without a workspace.
export async function runUpdateCheck(reportError: ReportError): Promise<void> {
  try {
    const result = await bridge().checkForUpdates();
    if (!result.checked) {
      reportError("No update check was started.", new Error(result.state.message));
    }
  } catch (error) {
    reportError("Could not check for updates.", error);
  }
}

export async function runUpdateInstall(reportError: ReportError): Promise<void> {
  try {
    // Through the guard: with set-aside drafts present the recovery dialog
    // opens instead of the one-shot install.
    const result = await requestGuardedUpdateInstall();
    if (result === null) return;
    // Main says why when it knows, such as a Linux password prompt that was closed.
    if (!result.accepted) {
      reportError(
        "Could not install the update.",
        new Error(
          result.reason ?? (result.state.status === "error" ? result.state.message : "The restart request was not accepted."),
        ),
      );
    }
  } catch (error) {
    reportError("Could not install the update.", error);
  }
}

/**
 * Menu commands in a window without the workspace shell: the manager, first
 * run, and the registry error. It answers the commands that need no
 * workspace. With no tab to close, Close tab closes the window on macOS.
 */
export function useMenuCommandsWithoutWorkspace(reportError: ReportError): void {
  useEffect(() => bridge().onMenuCommand((command) => {
    if (command === "check-updates") void runUpdateCheck(reportError);
    else if (command === "install-update") void runUpdateInstall(reportError);
    else if (command === "toggle-theme") toggleTheme();
    else if (command === "close-tab" && bridge().platform === "darwin") {
      void bridge().closeThisWindow().catch((error) =>
        reportError("Could not close this window.", error));
    }
  }), [reportError]);
}
