import type { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import {
  createOwnedWorkspaceReadPort,
  type OwnedWorkspaceReadPort,
  type OwnedWorkspaceSearchSource,
} from "./ownedWorkspaceReadPort";
import { usableShareMountRecord } from "./shareMounts";
import type { ShareViewFilesTarget } from "./shareViewFiles";
import {
  storedShareMounts,
  workspaceHasReceivedShareState,
  type ShareViewFilesWorkspaceRecord,
} from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";
import type { WorkspaceFileListingScope } from "./workspaceFileListingScope";

/** Compose the production read port from the workspace's owner records. */
export function createOwnedWorkspaceReads(input: {
  workspace: ShareViewFilesWorkspaceRecord;
  listFiles(scope?: WorkspaceFileListingScope): Promise<ListWorkspaceFilesResult>;
  repairProjection(target: ShareViewFilesTarget): Promise<void>;
  onSearchSourceFailure?: (
    source: OwnedWorkspaceSearchSource,
    error: unknown,
  ) => void;
}): OwnedWorkspaceReadPort {
  const mounts = storedShareMounts(input.workspace);
  const searchSources: OwnedWorkspaceSearchSource[] = shareViewIsPresent(
    input.workspace.shareView,
  )
    ? [
        {
          target: {
            kind: "standalone",
            workspaceId: input.workspace.workspaceId,
          },
        },
      ]
    : mounts
        .filter((mount) => usableShareMountRecord(mounts, mount))
        .map((mount) => ({
          target: {
            kind: "mount" as const,
            workspaceId: input.workspace.workspaceId,
            shareId: mount.shareId,
          },
          prefix: `${SHARED_WITH_ME_FOLDER}/${mount.label}`,
        }));

  return createOwnedWorkspaceReadPort({
    listFiles: input.listFiles,
    hasShareState: workspaceHasReceivedShareState(input.workspace),
    searchSources,
    repairProjection: input.repairProjection,
    ...(input.onSearchSourceFailure === undefined
      ? {}
      : { onSearchSourceFailure: input.onSearchSourceFailure }),
  });
}
