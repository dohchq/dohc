import type {
  ShareViewFileReadOutcome,
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
  readWorkspaceAsset,
  readWorkspaceText,
  type WorkspaceTextReadResult,
} from "./workspaceAssets";
import { importToDatabase } from "./workspaceDatabase";

export interface OwnedWorkspaceFileReader {
  resolveShare(path: string): Promise<{
    target: ShareViewFilesTarget;
    path: string;
  } | null>;
  readText(path: string): Promise<WorkspaceTextReadResult>;
  readAsset(
    path: string,
  ): Promise<Extract<ShareViewFileReadOutcome, { kind: "asset" }>>;
  readCompleteText(path: string): Promise<string>;
  importDatabase(input: {
    sourcePath: string;
    databasePath: string;
    tableName: string;
  }): Promise<{ path: string; tableName: string; rowCount: number }>;
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

  async function readAsset(
    path: string,
  ): Promise<Extract<ShareViewFileReadOutcome, { kind: "asset" }>> {
    const routed = await resolveShare(path);
    if (routed === null) {
      return {
        kind: "asset",
        ...(await readWorkspaceAsset(input.workspace.rootPath, path)),
      };
    }
    const read = await input.files.read(routed.target, {
      kind: "asset",
      path: routed.path,
    });
    if (read.kind !== "asset") {
      throw new Error("Shared asset read returned an invalid result.");
    }
    return read;
  }

  async function readCompleteText(path: string): Promise<string> {
    const source = await readAsset(path);
    return source.bytes.toString("utf8");
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

    readAsset,

    readCompleteText,

    async importDatabase({ sourcePath, databasePath, tableName }) {
      return importToDatabase(
        input.workspace.rootPath,
        { path: sourcePath, body: await readCompleteText(sourcePath) },
        databasePath,
        tableName,
      );
    },
  };
}
