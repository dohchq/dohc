import { join } from "node:path";
import { DOHC_TRASH_GUARD } from "@dohc/workspace-core";
import {
  localStateFolder,
  LocalStateUnavailableError,
  type LocalStateRefusal,
  type LocalStateWorkspace,
} from "./workspaceLocalState";

// The workspace trash keeps what a delete or a replacing move took when the
// system trash did not, what a settings Reset moved aside, and each delete's
// and move's recovery record. All of it describes what happened on this
// computer, so it lives in `.dohc/local`, which iCloud Drive skips. dohc
// neither reads nor moves an old `.dohc/trash`.

/** The workspace trash as a person sees it, from the workspace's root. */
export const WORKSPACE_TRASH = ".dohc/local/trash";

/** Where a staged entry is, for a reader that has already found the trash. */
export const stagedTrashEntry = (rootPath: string, staged: string) => join(rootPath, ".dohc", "local", "trash", staged);

/** What dohc says when it did not do `what` because the engine has not prepared `.dohc/local`. */
function trashNotReady(what: string, refusal: LocalStateRefusal): string {
  return refusal === "not-opened"
    ? `dohc did not ${what} because the workspace has not finished opening. Try again when it opens.`
    : `dohc did not ${what} because it can't keep this workspace's trash out of iCloud Drive. Restart dohc to try again.`;
}

/**
 * The workspace trash for a writer, made when missing. Refuses with
 * LocalStateUnavailableError, saying it did not `what`, unless the engine's
 * current open prepared `.dohc/local`. Refuses anything at the path but a
 * folder in the workspace only this user can change.
 */
export async function workspaceTrashForWrite(workspace: LocalStateWorkspace, what: string): Promise<string> {
  try {
    return await localStateFolder(workspace, "trash", DOHC_TRASH_GUARD);
  } catch (error) {
    if (error instanceof LocalStateUnavailableError) {
      throw new LocalStateUnavailableError(error.refusal, trashNotReady(what, error.refusal));
    }
    throw error;
  }
}
