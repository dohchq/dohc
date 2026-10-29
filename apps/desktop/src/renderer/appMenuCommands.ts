import { useEffect } from "react";
import { bridge } from "./bridge";
import { toggleTheme } from "./theme";
import type { UpdateAction } from "./UpdateButton";

type ReportError = (message: string, error: unknown) => void;

/**
 * Menu commands in a window without the workspace shell: the manager, first
 * run, and the registry error. It answers the commands that need no
 * workspace. With no tab to close, Close tab closes the window on macOS.
 */
export function useMenuCommandsWithoutWorkspace(
  reportError: ReportError,
  runUpdate: (action: UpdateAction) => Promise<void>,
): void {
  useEffect(() => bridge().onMenuCommand((command) => {
    if (command === "check-updates") void runUpdate("check");
    else if (command === "install-update") void runUpdate("install");
    else if (command === "toggle-theme") toggleTheme();
    else if (command === "close-tab" && bridge().platform === "darwin") {
      void bridge().closeThisWindow().catch((error) =>
        reportError("Could not close this window.", error));
    }
  }), [reportError, runUpdate]);
}
