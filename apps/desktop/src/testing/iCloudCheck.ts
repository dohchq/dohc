import { iCloudCheck, SF_DATALESS } from "../workspaces/workspaceICloudOnly";

/** Runs `work` with the iCloud check changed, then puts it back. */
export async function withICloudCheck<T>(changes: Partial<typeof iCloudCheck>, work: () => Promise<T>): Promise<T> {
  const saved = { ...iCloudCheck };
  Object.assign(iCloudCheck, changes);
  try {
    return await work();
  } finally {
    Object.assign(iCloudCheck, saved);
  }
}

/** The check as it runs on a Mac whose candidates all have only their names on disk. */
export const datalessCandidates: Partial<typeof iCloudCheck> = {
  applies: true,
  readFlags: async (paths) => paths.map(() => SF_DATALESS),
};
