import { workspacePathKey } from "./workspacePathKey";
import type { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
import type { ShareViewFilesTarget } from "./shareViewFiles";
import type { WorkspaceFileListingScope } from "./workspaceFileListingScope";

export interface OwnedWorkspaceSearchSource {
  target: ShareViewFilesTarget;
  // Absent only for a standalone shared view, where no ordinary files remain
  // available if its sole owner cannot repair.
  prefix?: string;
}

export interface OwnedWorkspaceReadPortInput {
  listFiles(scope?: WorkspaceFileListingScope): Promise<ListWorkspaceFilesResult>;
  hasShareState: boolean;
  searchSources: readonly OwnedWorkspaceSearchSource[];
  repairProjection(target: ShareViewFilesTarget): Promise<void>;
  onSearchSourceFailure?: (
    source: OwnedWorkspaceSearchSource,
    error: unknown,
  ) => void;
}

/** What a search over the owned workspace may read and return. */
export interface OwnedWorkspaceSearchView {
  includeGlob?: string;
  allowPath(path: string): boolean;
  // null means every path belongs to the local workspace, so callers do not
  // need an owner listing to filter a full-workspace search.
  listing: ListWorkspaceFilesResult | null;
}

/** The owned workspace's file listing and search scope: owner bytes for
 * received shares, the disk for everything else. */
export interface OwnedWorkspaceReadPort {
  listFiles(scope?: WorkspaceFileListingScope): Promise<ListWorkspaceFilesResult>;
  prepareSearch(path?: string): Promise<OwnedWorkspaceSearchView>;
}

function isAtOrBelowPrefix(path: string, prefix: string): boolean {
  const comparedPath = workspacePathKey(path);
  const comparedPrefix = workspacePathKey(prefix);
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
  const requestedKey = workspacePathKey(requestedPath);
  const file = listed.files.find(
    (entry) => workspacePathKey(entry.path) === requestedKey,
  );
  if (file) return literalGlob(file.path);
  const folder = (listed.folders ?? []).find(
    (candidate) => workspacePathKey(candidate) === requestedKey,
  );
  return `${literalGlob(folder ?? requestedPath)}/**`;
}

export function createOwnedWorkspaceReadPort(
  input: OwnedWorkspaceReadPortInput,
): OwnedWorkspaceReadPort {
  return {
    listFiles: input.listFiles,

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
      const allowed = new Set(
        visible.files.map((file) => workspacePathKey(file.path)),
      );
      const includeGlob = includeGlobForOwnerListing(visible, requestedPath);
      return {
        listing: visible,
        ...(includeGlob !== undefined ? { includeGlob } : {}),
        allowPath: (path) => allowed.has(workspacePathKey(path)),
      };
    },
  };
}
