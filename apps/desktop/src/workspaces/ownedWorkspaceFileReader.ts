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
  readDatabasePageFromBytes,
  readDatabaseSnapshotFromBytes,
  readPreparedDatabasePage,
  readPreparedDatabaseSnapshot,
  type DatabasePageView,
  type DatabaseSnapshotView,
} from "./workspaceDatabase";

export interface OwnedWorkspaceDatabaseReader {
  readPrepared(
    path: string,
    source: PreparedWorkspaceFileRead,
  ): Promise<DatabaseSnapshotView>;
  readBytes(path: string, bytes: Uint8Array): Promise<DatabaseSnapshotView>;
  readPagePrepared(
    path: string,
    source: PreparedWorkspaceFileRead,
    table: string,
    offset: number,
  ): Promise<DatabasePageView>;
  readPageBytes(
    path: string,
    bytes: Uint8Array,
    table: string,
    offset: number,
  ): Promise<DatabasePageView>;
}

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
  readDatabasePage(
    path: string,
    table: string,
    offset: number,
  ): Promise<DatabasePageView>;
}

/** Reads local files from disk and received-share files from their owner store. */
export function createOwnedWorkspaceFileReader(input: {
  workspace: ShareViewFilesWorkspaceRecord;
  files: Pick<ShareViewFiles, "read">;
  databaseReader?: OwnedWorkspaceDatabaseReader;
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

  const databaseReader: OwnedWorkspaceDatabaseReader =
    input.databaseReader ?? {
      readPrepared: readPreparedDatabaseSnapshot,
      readBytes: readDatabaseSnapshotFromBytes,
      readPagePrepared: readPreparedDatabasePage,
      readPageBytes: readDatabasePageFromBytes,
    };

  async function preparedDatabase(path: string): Promise<
    | { kind: "local"; source: PreparedWorkspaceFileRead }
    | { kind: "share"; path: string; bytes: Uint8Array }
  > {
    const prepared = await prepareRead(path);
    if (prepared.kind === "local") return prepared;
    const read = await input.files.read(prepared.target, {
      kind: "asset",
      path: prepared.path,
    });
    if (read.kind !== "asset") {
      throw new Error("Shared database read returned an invalid result.");
    }
    return { kind: "share", path: prepared.path, bytes: read.bytes };
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
      const prepared = await preparedDatabase(path);
      if (prepared.kind === "local") {
        return databaseReader.readPrepared(path, prepared.source);
      }
      return databaseReader.readBytes(path, prepared.bytes);
    },

    async readDatabasePage(path, table, offset) {
      const prepared = await preparedDatabase(path);
      if (prepared.kind === "local") {
        return databaseReader.readPagePrepared(
          path,
          prepared.source,
          table,
          offset,
        );
      }
      return databaseReader.readPageBytes(
        path,
        prepared.bytes,
        table,
        offset,
      );
    },
  };
}
