import type { ListWorkspaceFilesResult } from "../ipc/bridgeContract";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import { createOwnedWorkspaceFileReader } from "./ownedWorkspaceFileReader";
import {
  createOwnedWorkspaceSdkReadPort,
  type OwnedWorkspaceSdkReadPort,
  type OwnedWorkspaceSearchSource,
} from "./ownedWorkspaceSdkReadPort";
import { usableShareMountRecord } from "./shareMounts";
import type { ShareViewFiles, ShareViewFilesTarget } from "./shareViewFiles";
import {
  storedShareMounts,
  workspaceHasReceivedShareState,
  type ShareViewFilesWorkspaceRecord,
} from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";

/** Compose the production SDK read port from the workspace's owner records. */
export function createOwnedWorkspaceSdkReads(input: {
  workspace: ShareViewFilesWorkspaceRecord;
  files: Pick<ShareViewFiles, "read">;
  listFiles(): Promise<ListWorkspaceFilesResult>;
  repairProjection(target: ShareViewFilesTarget): Promise<void>;
  onSearchSourceFailure?: (
    source: OwnedWorkspaceSearchSource,
    error: unknown,
  ) => void;
}): OwnedWorkspaceSdkReadPort {
  const fileReader = createOwnedWorkspaceFileReader({
    workspace: input.workspace,
    files: input.files,
  });
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

  return createOwnedWorkspaceSdkReadPort({
    readText: (path) => fileReader.readText(path),
    listFiles: input.listFiles,
    readDatabase: (path) => fileReader.readDatabase(path),
    hasShareState: workspaceHasReceivedShareState(input.workspace),
    searchSources,
    repairProjection: input.repairProjection,
    ...(input.onSearchSourceFailure === undefined
      ? {}
      : { onSearchSourceFailure: input.onSearchSourceFailure }),
  });
}
