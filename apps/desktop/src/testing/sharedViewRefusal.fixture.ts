import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shareViewFilesProjection } from "../workspaces/sharedView";
import { withShareViewFilesOwner } from "../workspaces/shareViewFilesOwner";
import { createTestScratch } from "../workspaces/testTemp";
import { withExclusiveWorkspaceOperation } from "../workspaces/workspaceAssets";
import { readLocalStateFrom } from "../workspaces/workspaceLocalState";

export const sharedViewRefusalWords =
  "dohc did not update these shared files because it could not read .dohc/local/share-refresh/share-collision-record.json. " +
  "It keeps a refresh from replacing your own files.";

export async function sharedViewRefusal(): Promise<unknown> {
  const rootPath = await createTestScratch("shared-view-refusal-");
  const folder = join(rootPath, ".dohc", "local", "share-refresh");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, "share-collision-record.json"), "not json", { mode: 0o600 });
  if (process.platform === "win32") {
    const binding = { localStateReady: true };
    readLocalStateFrom({ currentBinding: () => binding, localStateOpenAt: async () => ({ current: () => true }) });
  }
  try {
    return await withExclusiveWorkspaceOperation(rootPath, async (_changed, workspaceLease) => {
      return withShareViewFilesOwner({ workspaceLease, resource: {
        kind: "standalone", workspaceId: "refused-view", storeWorkspaceId: "refused-view",
        rootPath, schedulingRootPath: rootPath, shareId: "share",
      } }, async capability => {
        try {
          await shareViewFilesProjection(capability).recordCollisions(rootPath, "share", ["docs/a.md"]);
        } catch (error) {
          return error;
        }
        throw new Error("Expected the shared file read to refuse.");
      });
    });
  } finally {
    if (process.platform === "win32") readLocalStateFrom(null);
  }
}
