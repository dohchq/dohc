import {
  existingLocalStateFolder,
  localStateFolder,
  LocalStateUnavailableError,
  type LocalStateWorkspace,
} from "./workspaceLocalState";

// What dohc keeps for a workspace's Collections on this computer only: the
// workers that hold a Collection's records while it is open, the files it
// stages to export, restore or move a Collection, and offline copies of
// Collections on a server. All of it can be made again, so it lives in
// `.dohc/local`, which iCloud Drive skips. The Collections themselves stay in
// `.dohc/datasets/state.sqlite`, which no path here leads to.

const FOLDERS = {
  workers: { path: "datasets/workers", what: "open this Collection's records" },
  exports: { path: "datasets/exports", what: "prepare this Collection's recovery file" },
  copies: { path: "dataset-copies", what: "open this Collection's offline copy" },
} as const;

export type LocalDatasetFolder = keyof typeof FOLDERS;

/**
 * One of the Collection folders in `.dohc/local`, or a folder in it, for a
 * writer, made 0700 when missing. Refuses with LocalStateUnavailableError,
 * saying what dohc did not do, unless the engine's current open of the
 * workspace prepared `.dohc/local`. Never creates `.dohc/local`.
 */
export async function localDatasetFolder(workspace: LocalStateWorkspace, folder: LocalDatasetFolder, child?: string): Promise<string> {
  const { path, what } = FOLDERS[folder];
  const name = child === undefined ? path : `${path}/${child}`;
  try {
    return await localStateFolder(workspace, name, { path: `.dohc/local/${name}`, lead: `dohc could not ${what}.` });
  } catch (error) {
    if (!(error instanceof LocalStateUnavailableError)) throw error;
    throw new LocalStateUnavailableError(error.refusal, error.refusal === "not-opened"
      ? `dohc did not ${what} because the workspace has not finished opening. Try again when it opens.`
      : `dohc did not ${what} because it can't keep this workspace's .dohc/local out of iCloud Drive. Restart dohc to try again.`);
  }
}

/** The export folder for a reader, or null when it is missing or not one only this user can change. */
export async function existingLocalDatasetExports(rootPath: string): Promise<string | null> {
  const dir = await existingLocalStateFolder(rootPath, FOLDERS.exports.path);
  return dir === "unusable" ? null : dir;
}
