import {
  WorkspaceSearchInput,
  type WorkspaceSearchResult,
} from "@dohc/workspace-contracts/retrieval";
import { isSharedWithMePath } from "@dohc/workspace-core";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";

function isMountedShareFilter(raw: string | undefined): boolean {
  if (!raw) return false;
  const trimmed = raw.trim().replace(/^\/+|\/+$/gu, "");
  return trimmed.length > 0 && isSharedWithMePath(trimmed);
}

export function createWorkspaceRetrievalReader(deps: {
  withAdapter: <T>(
    workspace: RegistryEntry,
    run: (adapter: VersionedLiveAdapter) => Promise<T>,
  ) => Promise<T | null>;
  syncWorkspaceSharedChannels(workspaceId: string): Promise<number>;
}) {
  return {
    async search(
      workspace: RegistryEntry,
      input: WorkspaceSearchInput,
    ): Promise<WorkspaceSearchResult> {
      if (shareViewIsPresent(workspace.shareView)) {
        throw new Error("Only the original workspace supports workspace search.");
      }
      const parsed = WorkspaceSearchInput.parse(input);
      if (isMountedShareFilter(parsed.pathPrefix) || isMountedShareFilter(parsed.collectionPath)) {
        throw new Error("Mounted shared folders under shared-with-me/ are not searched.");
      }
      const includesChat = parsed.surfaces === undefined || parsed.surfaces.includes("chat");
      const hasLiveSharedChannels =
        workspace.sharedChannels?.some((channel) => channel.ended !== true) ?? false;
      const uncovered =
        includesChat && hasLiveSharedChannels
          ? await deps.syncWorkspaceSharedChannels(workspace.workspaceId)
          : 0;
      const result = await deps.withAdapter(workspace, (adapter) =>
        adapter.retrieveWorkspace(parsed),
      );
      if (!result) throw new Error("Workspace engine is unavailable.");
      const sharedChannelRowsUncovered = result.sharedChannelRowsUncovered + uncovered;
      const mountsCovered = result.mountsCovered && !workspace.shareMounts?.length;
      return {
        ...result,
        mountsCovered,
        sharedChannelRowsUncovered,
        complete: result.complete && sharedChannelRowsUncovered === 0,
      };
    },
  };
}
