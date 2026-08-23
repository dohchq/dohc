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
import { resolveShareMountPath } from "./shareMounts";
import {
  readWorkspaceAssetSource,
  readWorkspaceText,
  type WorkspaceTextReadResult,
} from "./workspaceAssets";

export interface OwnedWorkspaceFileSource {
  /** The authoritative owner-relative path after following aliases. */
  path: string;
  bytes: Buffer;
}

export interface OwnedWorkspaceFileReader {
  resolveShare(path: string): Promise<{
    target: ShareViewFilesTarget;
    path: string;
  } | null>;
  readText(path: string): Promise<WorkspaceTextReadResult>;
  readAsset(
    path: string,
  ): Promise<Extract<ShareViewFileReadOutcome, { kind: "asset" }>>;
  readCompleteSource(path: string): Promise<OwnedWorkspaceFileSource>;
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

  async function readAssetSource(path: string): Promise<{
    path: string;
    kind: "asset";
    bytes: Buffer;
    mediaType: string;
  }> {
    const routed = await resolveShare(path);
    if (routed === null) {
      const source = await readWorkspaceAssetSource(
        input.workspace.rootPath,
        path,
      );
      return {
        path: source.path,
        kind: "asset",
        bytes: source.bytes,
        mediaType: source.mediaType,
      };
    }
    const read = await input.files.read(routed.target, {
      kind: "asset",
      path: routed.path,
    });
    if (read.kind !== "asset") {
      throw new Error("Shared asset read returned an invalid result.");
    }
    return { path: routed.path, ...read };
  }

  async function readAsset(
    path: string,
  ): Promise<Extract<ShareViewFileReadOutcome, { kind: "asset" }>> {
    const { path: _path, ...asset } = await readAssetSource(path);
    return asset;
  }

  async function readCompleteSource(
    path: string,
  ): Promise<OwnedWorkspaceFileSource> {
    const source = await readAssetSource(path);
    return { path: source.path, bytes: source.bytes };
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

    readCompleteSource,
  };
}
