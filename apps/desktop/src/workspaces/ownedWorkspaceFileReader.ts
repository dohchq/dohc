import type {
  ShareViewFileReadOutcome,
  ShareViewFiles,
  ShareViewFilesTarget,
} from "./shareViewFiles";
import {
  shareMountRegistryIsPresent,
  storedShareMounts,
  type ShareViewFilesWorkspaceRecord,
} from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";
import {
  prepareShareProjectionRead,
  resolveShareMountPath,
} from "./shareMounts";
import type {
  PreparedWorkspaceFileRead,
  WorkspaceTextReadResult,
} from "./workspaceAssets";
import {
  readDatabaseSnapshotFromBytes,
  readPreparedDatabaseSnapshot,
  type DatabaseSnapshotView,
} from "./workspaceDatabase";

export interface OwnedWorkspaceFileReader {
  resolveShare(path: string): Promise<{
    target: ShareViewFilesTarget;
    path: string;
  } | null>;
  readText(path: string): Promise<WorkspaceTextReadResult>;
  readAsset(
    path: string,
  ): Promise<
    { path: string } & Extract<ShareViewFileReadOutcome, { kind: "asset" }>
  >;
  readDatabase(path: string): Promise<DatabaseSnapshotView>;
}

/** Reads local files from disk and received-share files from their owner store. */
export function createOwnedWorkspaceFileReader(input: {
  workspace: ShareViewFilesWorkspaceRecord;
  files: Pick<ShareViewFiles, "read">;
}): OwnedWorkspaceFileReader {
  type PreparedRead =
    | { kind: "local"; source: PreparedWorkspaceFileRead }
    | { kind: "share"; target: ShareViewFilesTarget; path: string };

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
      shareMountRegistryIsPresent(input.workspace),
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

  async function prepareRead(path: string): Promise<PreparedRead> {
    if (shareViewIsPresent(input.workspace.shareView)) {
      return {
        kind: "share",
        target: {
          kind: "standalone",
          workspaceId: input.workspace.workspaceId,
        },
        path,
      };
    }
    const prepared = await prepareShareProjectionRead(
      input.workspace.rootPath,
      path,
      storedShareMounts(input.workspace),
      shareMountRegistryIsPresent(input.workspace),
    );
    return prepared.kind === "local"
      ? prepared
      : {
          kind: "share",
          target: {
            kind: "mount",
            workspaceId: input.workspace.workspaceId,
            shareId: prepared.mount.shareId,
          },
          path: prepared.path,
        };
  }

  async function readAsset(path: string): Promise<{
    path: string;
    kind: "asset";
    bytes: Buffer;
    mediaType: string;
  }> {
    const prepared = await prepareRead(path);
    if (prepared.kind === "local") {
      const source = await prepared.source.readAsset();
      return {
        path: source.path,
        kind: "asset",
        bytes: source.bytes,
        mediaType: source.mediaType,
      };
    }
    const read = await input.files.read(prepared.target, {
      kind: "asset",
      path: prepared.path,
    });
    if (read.kind !== "asset") {
      throw new Error("Shared asset read returned an invalid result.");
    }
    return { path: prepared.path, ...read };
  }

  return {
    resolveShare,

    async readText(path) {
      const prepared = await prepareRead(path);
      if (prepared.kind === "local") {
        return prepared.source.readText();
      }
      const read = await input.files.read(prepared.target, {
        kind: "text",
        path: prepared.path,
      });
      if (read.kind !== "text") {
        throw new Error("Shared text read returned an invalid result.");
      }
      return read;
    },

    readAsset,

    async readDatabase(path) {
      const prepared = await prepareRead(path);
      if (prepared.kind === "local") {
        return readPreparedDatabaseSnapshot(path, prepared.source);
      }
      const read = await input.files.read(prepared.target, {
        kind: "asset",
        path: prepared.path,
      });
      if (read.kind !== "asset") {
        throw new Error("Shared database read returned an invalid result.");
      }
      return readDatabaseSnapshotFromBytes(path, read.bytes);
    },
  };
}
