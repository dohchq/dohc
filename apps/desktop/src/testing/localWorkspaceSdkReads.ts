import { readWorkspaceText } from "../workspaces/workspaceAssets";
import { readDatabaseSnapshot } from "../workspaces/workspaceDatabase";
import { listFiles } from "../workspaces/workspaceFiles";
import { createOwnedWorkspaceSdkReadPort } from "../workspaces/ownedWorkspaceSdkReadPort";
import type { WorkspaceSdkReadPort } from "../workspaces/workspaceSdkHost";

/** Explicit raw-disk read authority for local-workspace test fixtures. */
export function localWorkspaceSdkReads(
  workspaceRoot: string,
): WorkspaceSdkReadPort {
  return createOwnedWorkspaceSdkReadPort({
    readText: (path) => readWorkspaceText(workspaceRoot, path),
    listFiles: () => listFiles(workspaceRoot),
    readDatabase: (path) => readDatabaseSnapshot(workspaceRoot, path),
    hasShareState: false,
    searchSources: [],
    repairProjection: async () => undefined,
  });
}
