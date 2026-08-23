import type { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
import type { WorkspaceTextReadResult } from "./workspaceAssets";
import type { DatabaseSnapshotView } from "./workspaceDatabase";
import type { ShareViewFilesTarget } from "./shareViewFiles";
import type {
  WorkspaceSdkReadPort,
  WorkspaceSdkSearchView,
} from "./workspaceSdkHost";

export interface OwnedWorkspaceSearchSource {
  target: ShareViewFilesTarget;
  // Absent only for a standalone shared view, where no ordinary files remain
  // available if its sole owner cannot repair.
  prefix?: string;
}

export interface OwnedWorkspaceSdkReadPortInput {
  readText(path: string): Promise<WorkspaceTextReadResult>;
  listFiles(): Promise<ListWorkspaceFilesResult>;
  readDatabase(path: string): Promise<DatabaseSnapshotView>;
  hasShareState: boolean;
  searchSources: readonly OwnedWorkspaceSearchSource[];
  repairProjection(target: ShareViewFilesTarget): Promise<void>;
  onSearchSourceFailure?: (
    source: OwnedWorkspaceSearchSource,
    error: unknown,
  ) => void;
}

export interface OwnedWorkspaceSearchView extends WorkspaceSdkSearchView {
  // null means every path belongs to the local workspace, so callers do not
  // need an owner listing to filter a full-workspace search.
  listing: ListWorkspaceFilesResult | null;
}

export interface OwnedWorkspaceSdkReadPort
  extends Omit<WorkspaceSdkReadPort, "prepareSearch"> {
  prepareSearch(path?: string): Promise<OwnedWorkspaceSearchView>;
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isAtOrBelowPrefix(path: string, prefix: string): boolean {
  const comparedPath = pathKey(path);
  const comparedPrefix = pathKey(prefix);
  return (
    comparedPath === comparedPrefix ||
    comparedPath.startsWith(`${comparedPrefix}/`)
  );
}

function literalGlob(path: string): string {
  return path.replace(/([*?[\]{}!\\])/g, "\\$1");
}

function includeGlobForOwnerListing(
  listed: Pick<ListWorkspaceFilesResult, "files" | "folders">,
  requestedPath: string | undefined,
): string | undefined {
  if (requestedPath === undefined) return undefined;
  const requestedKey = pathKey(requestedPath);
  const file = listed.files.find((entry) => pathKey(entry.path) === requestedKey);
  if (file) return literalGlob(file.path);
  const folder = (listed.folders ?? []).find(
    (candidate) => pathKey(candidate) === requestedKey,
  );
  return `${literalGlob(folder ?? requestedPath)}/**`;
}

export function createOwnedWorkspaceSdkReadPort(
  input: OwnedWorkspaceSdkReadPortInput,
): OwnedWorkspaceSdkReadPort {
  return {
    readText: input.readText,
    listFiles: input.listFiles,
    readDatabase: input.readDatabase,

    async prepareSearch(requestedPath): Promise<OwnedWorkspaceSearchView> {
      if (!input.hasShareState && requestedPath === undefined) {
        return { listing: null, allowPath: () => true };
      }
      const failedPrefixes: string[] = [];
      for (const source of input.searchSources) {
        try {
          await input.repairProjection(source.target);
        } catch (error) {
          if (source.prefix === undefined) throw error;
          failedPrefixes.push(source.prefix);
          input.onSearchSourceFailure?.(source, error);
        }
      }

      const listed = await input.listFiles();
      const visible = {
        files: listed.files.filter(
          (file) =>
            !failedPrefixes.some((prefix) =>
              isAtOrBelowPrefix(file.path, prefix),
            ),
        ),
        folders: (listed.folders ?? []).filter(
          (folder) =>
            !failedPrefixes.some((prefix) =>
              isAtOrBelowPrefix(folder, prefix),
            ),
        ),
      };
      const allowed = new Set(visible.files.map((file) => pathKey(file.path)));
      const includeGlob = includeGlobForOwnerListing(visible, requestedPath);
      return {
        listing: visible,
        ...(includeGlob !== undefined ? { includeGlob } : {}),
        allowPath: (path) => allowed.has(pathKey(path)),
      };
    },
  };
}
