import type {
  ShareViewFiles,
  ShareViewFilesTarget,
} from "./shareViewFiles";
import {
  storedShareMounts,
  type ShareViewFilesWorkspaceRecord,
} from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";
import { resolveShareMountPath } from "./shareMounts";
import {
  readWorkspaceText,
  type WorkspaceTextReadResult,
} from "./workspaceAssets";

export interface OwnedWorkspaceFileReader {
  resolveShare(path: string): Promise<{
    target: ShareViewFilesTarget;
    path: string;
  } | null>;
  readText(path: string): Promise<WorkspaceTextReadResult>;
}

/** Reads local files from disk and received-share files from their owner store. */
export function createOwnedWorkspaceFileReader(input: {
  workspace: ShareViewFilesWorkspaceRecord;
  files: Pick<ShareViewFiles, "read">;
}): OwnedWorkspaceFileReader {
  async function resolveShare(path: string): Promise<{
    target: ShareViewFilesTarget;
    path: string;
  } | null> {
    if (shareViewIsPresent(input.workspace.shareView)) {
      return {
        target: {
          kind: "standalone",
          workspaceId: input.workspace.workspaceId,
        },
        path,
      };
    }
    const resolved = await resolveShareMountPath(
      input.workspace.rootPath,
      path,
      storedShareMounts(input.workspace),
      input.workspace.shareMounts !== undefined,
    );
    return resolved === null
      ? null
      : {
          target: {
            kind: "mount",
            workspaceId: input.workspace.workspaceId,
            shareId: resolved.mount.shareId,
          },
          path: resolved.path,
        };
  }

  return {
    resolveShare,

    async readText(path) {
      const routed = await resolveShare(path);
      if (routed === null) {
        return readWorkspaceText(input.workspace.rootPath, path);
      }
      const read = await input.files.read(routed.target, {
        kind: "text",
        path: routed.path,
      });
      if (read.kind !== "text") {
        throw new Error("Shared text read returned an invalid result.");
      }
      return read;
    },
  };
}
