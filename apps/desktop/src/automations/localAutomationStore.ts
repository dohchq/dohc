import type { AutomationStoreFolder } from "@dohc/automation-executor/automation-run-store";
import {
  localStateDir,
  LocalStateUnavailableError,
  ownedLocalStateDir,
  type LocalStateRefusal,
  type LocalStateWorkspace,
} from "../workspaces/workspaceLocalState";

// This computer's automation runs, Undo and Stop and restore progress, and the
// steps a person allowed, for one workspace, in `.dohc/local/automations`.
// They describe what ran here, so they stay out of iCloud Drive.

function notSaved(refusal: LocalStateRefusal): string {
  return refusal === "not-opened"
    ? "dohc did not save automation progress because the workspace has not finished opening. Try again when it opens."
    : "dohc did not save automation progress because it can't keep this computer's automation progress out of iCloud Drive. Restart dohc to try again.";
}

/**
 * The run store's folder for a workspace. A write waits for the engine's open
 * to prepare `.dohc/local`, and a refused write changes nothing already
 * saved. A read needs only `.dohc` and `.dohc/local` to be this user's own
 * folders.
 */
export function localAutomationStoreFolder(workspace: LocalStateWorkspace): AutomationStoreFolder {
  return {
    async forWrite() {
      try {
        return await localStateDir(workspace);
      } catch (error) {
        if (error instanceof LocalStateUnavailableError) throw new LocalStateUnavailableError(error.refusal, notSaved(error.refusal));
        throw error;
      }
    },
    forRead: () => ownedLocalStateDir(workspace.rootPath),
  };
}
