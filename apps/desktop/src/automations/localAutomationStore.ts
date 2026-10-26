import { AutomationStoreNotOpenedError, type AutomationStoreFolder } from "@dohc/automation-executor/automation-run-store";
import {
  localStateDir,
  LocalStateUnavailableError,
  readOwnedLocalState,
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
 * The run store's folder for a workspace. A write is refused at once, with
 * these words, unless the engine's current open has prepared `.dohc/local`;
 * it does not wait, and a refused write changes nothing already saved. A read
 * needs `.dohc` and `.dohc/local` to be this user's own folders, and on
 * Windows the engine's open to hold `.dohc/local` throughout. Before that
 * open, or once it closes, a read says the workspace has not opened, not that
 * the steps a person allowed can't be read.
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
    async read(work) {
      try {
        return await readOwnedLocalState(workspace.rootPath, work);
      } catch (error) {
        if (error instanceof LocalStateUnavailableError) throw new AutomationStoreNotOpenedError(error.message);
        throw error;
      }
    },
  };
}
