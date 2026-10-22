import {
  localStateFolder,
  LocalStateUnavailableError,
  readOwnedLocalStateFolder,
  type LocalStateWorkspace,
} from "./workspaceLocalState";

// What dohc keeps for a workspace's Collections on this computer only, in
// `.dohc/local`, which iCloud Drive skips. `datasets/state.sqlite`, with its
// -wal and -shm, is the Collections store: the only copy of their records,
// files, approvals and History. It can't be made again, so nothing removes
// `datasets`. The rest can be made again: the workers that hold a
// Collection's records while it is open, the files dohc stages to export,
// restore or move a Collection, and offline copies of Collections on a server.

const FOLDERS = {
  store: { path: "datasets", what: "open this workspace's Collections" },
  workers: { path: "datasets/workers", what: "open this Collection's records" },
  exports: { path: "datasets/exports", what: "prepare this Collection's recovery file" },
  copies: { path: "dataset-copies", what: "open this Collection's offline copy" },
} as const;

export type LocalDatasetFolder = keyof typeof FOLDERS;

/** The store's file name in its folder. */
export const STORE_FILE = "state.sqlite";
/** Where the store is, as a person finds it in the workspace. */
export const STORE_PATH = `.dohc/local/${FOLDERS.store.path}/${STORE_FILE}`;
/**
 * Where the store was before `.dohc/local`. iCloud Drive syncs it, so only
 * the computer that keeps the Collections moves a store from there, once.
 */
export const OLD_STORE_PATH = `.dohc/datasets/${STORE_FILE}`;

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

/**
 * Reads the export folder with `read`, given the folder, or null when it is
 * missing or not one only this user can change. Refuses as
 * readOwnedLocalStateFolder does.
 */
export function readLocalDatasetExports<T>(rootPath: string, read: (dir: string | null) => Promise<T>): Promise<T> {
  return readOwnedLocalStateFolder(rootPath, FOLDERS.exports.path, (dir) => read(dir === "unusable" ? null : dir));
}
