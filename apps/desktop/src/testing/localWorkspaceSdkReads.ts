import { readWorkspaceText } from "../workspaces/workspaceAssets";
import { readDatabaseSnapshot } from "../workspaces/workspaceDatabase";
import { listFiles } from "../workspaces/workspaceFiles";
import type {
  WorkspaceSdkReadPort,
  WorkspaceSdkSearchView,
} from "../workspaces/workspaceSdkHost";

function literalGlob(path: string): string {
  return path.replace(/([*?[\]{}!\\])/g, "\\$1");
}

/** Explicit raw-disk read authority for local-workspace test fixtures. */
export function localWorkspaceSdkReads(
  workspaceRoot: string,
): WorkspaceSdkReadPort {
  return {
    readText: (path) => readWorkspaceText(workspaceRoot, path),
    listFiles: () => listFiles(workspaceRoot),
    async prepareSearch(requestedPath): Promise<WorkspaceSdkSearchView> {
      if (requestedPath === undefined) return { allowPath: () => true };
      const listed = await listFiles(workspaceRoot);
      const escaped = literalGlob(requestedPath);
      const file = listed.files.some((entry) => entry.path === requestedPath);
      return {
        includeGlob: file ? escaped : `${escaped}/**`,
        allowPath: () => true,
      };
    },
    readDatabase: (path) => readDatabaseSnapshot(workspaceRoot, path),
  };
}
