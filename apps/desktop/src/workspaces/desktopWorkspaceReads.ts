import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { createDesktopEngine } from "./desktopEngine";
import type { createOwnedProjectionRepairer } from "./ownedProjectionRepair";
import {
  createOwnedWorkspaceFileReader,
  type OwnedWorkspaceDatabaseReader,
} from "./ownedWorkspaceFileReader";
import { createOwnedWorkspaceSdkReads } from "./ownedWorkspaceSdkReads";
import type { createReceivedShareEngineAccess } from "./receivedShareEngineAccess";
import type { RegistryEntry } from "./registryStore";
import { overlayCanonicalShareMountFiles } from "./shareMounts";
import type { ShareViewFiles, ShareViewFilesTarget } from "./shareViewFiles";
import { shareMountRegistryIsPresent, storedShareMounts } from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";
import type { WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import { listFiles } from "./workspaceFiles";

export interface DesktopWorkspaceReadsDependencies {
  readonly desktopEngine: Pick<ReturnType<typeof createDesktopEngine>, "startup">;
  readonly shareViewFiles: Pick<ShareViewFiles, "read" | "list">;
  readonly receivedShareEngine: Pick<
    ReturnType<typeof createReceivedShareEngineAccess>,
    "workspaceForRegistered"
  >;
  readonly ensureOwnedProjectionTargetCurrent: ReturnType<
    typeof createOwnedProjectionRepairer
  >;
  withPhysicalWorkspaceOperation<Result>(
    workspaceId: string,
    work: (
      operation: Pick<WorkspaceAuthorityOperation<RegistryEntry, unknown>, "workspace">,
    ) => Result | Promise<Result>,
  ): Promise<Result>;
  withEngineAdapter<Result>(
    workspace: EngineWorkspace,
    work: (adapter: VersionedLiveAdapter) => Promise<Result>,
  ): Promise<Result | null>;
  isRecordValue(value: unknown): value is Record<string, unknown>;
}

export function createDesktopWorkspaceReads(dependencies: DesktopWorkspaceReadsDependencies) {
  const { withPhysicalWorkspaceOperation, withEngineAdapter, isRecordValue } = dependencies;

  async function shareViewFilesTargetForPath(
    workspace: { workspaceId: string },
    relativePath: string,
  ): Promise<{ target: ShareViewFilesTarget; path: string } | null> {
    return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) =>
      createOwnedWorkspaceFileReader({
        workspace: operation.workspace,
        files: dependencies.shareViewFiles,
      }).resolveShare(relativePath),
    );
  }

  // Share-backed reads answer from the engine share store, and a restored
  // share tab's first read can precede the daemon handshake (the window loads
  // during it). Ungated, that read errors once and nothing retries it: a
  // current share reports zero changed paths, so no refresh-key bump ever
  // re-reads the tab. Only the share branch calls `read`, so local disk reads
  // stay concurrent with the handshake.
  const gatedShareViewFileReads: Pick<ShareViewFiles, "read"> = {
    read: async (target, request) => {
      await dependencies.desktopEngine.startup;
      return dependencies.shareViewFiles.read(target, request);
    },
  };

  async function readOwnedWorkspaceText(
    workspace: { workspaceId: string },
    relativePath: string,
  ) {
    return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) =>
      readOwnedWorkspaceTextFor(operation.workspace, relativePath),
    );
  }

  function readOwnedWorkspaceTextFor(
    workspace: RegistryEntry & { readonly attachmentId: symbol },
    relativePath: string,
  ) {
    return createOwnedWorkspaceFileReader({
      workspace,
      files: gatedShareViewFileReads,
    }).readText(relativePath);
  }

  async function readOwnedWorkspaceAsset(
    workspace: { workspaceId: string },
    relativePath: string,
  ) {
    return withPhysicalWorkspaceOperation(workspace.workspaceId, (operation) =>
      readOwnedWorkspaceAssetFor(operation.workspace, relativePath),
    );
  }

  function readOwnedWorkspaceAssetFor(
    workspace: RegistryEntry & { readonly attachmentId: symbol },
    relativePath: string,
  ) {
    return createOwnedWorkspaceFileReader({
      workspace,
      files: gatedShareViewFileReads,
    }).readAsset(relativePath);
  }

  async function listOwnedWorkspaceFilesFor(
    workspace: RegistryEntry & { readonly attachmentId: symbol },
  ) {
    if (shareViewIsPresent(workspace.shareView)) {
      // The shell lists at mount, which can precede the daemon handshake now
      // that the window loads during it; the share store needs sessions. A
      // plain workspace's disk listing below stays ungated on purpose.
      await dependencies.desktopEngine.startup;
      return dependencies.shareViewFiles.list(
        {
          kind: "standalone",
          workspaceId: workspace.workspaceId,
        },
        { includeContentIdentity: true },
      );
    }
    const mounts = storedShareMounts(workspace);
    const disk = await listFiles(workspace.rootPath, {
      includeContentIdentity: true,
    });
    if (!shareMountRegistryIsPresent(workspace)) return disk;
    await dependencies.desktopEngine.startup;
    return overlayCanonicalShareMountFiles({
      disk,
      mounts,
      listCanonical: (mount) =>
        dependencies.shareViewFiles.list(
          {
            kind: "mount",
            workspaceId: workspace.workspaceId,
            shareId: mount.shareId,
          },
          { includeContentIdentity: true },
        ),
      onFailure: (mount, error) => {
        const identity = isRecordValue(mount)
          ? `"${String(mount.label)}" (${String(mount.shareId)})`
          : "from an unreadable registry record";
        console.error(
          `[desktop] could not list mounted share ${identity}`,
          error,
        );
      },
    });
  }

  function ownedWorkspaceReadsFor(
    workspace: RegistryEntry & { readonly attachmentId: symbol },
    databaseReader?: OwnedWorkspaceDatabaseReader,
  ) {
    // The same engine boundary the renderer's collections.* IPC uses: a
    // received share reads its share engine, everything else the local one.
    const collectionAdapter = async <T>(
      work: (adapter: VersionedLiveAdapter) => Promise<T>,
    ): Promise<T> => {
      const result = await withEngineAdapter(
        dependencies.receivedShareEngine.workspaceForRegistered(workspace),
        work,
      );
      if (result === null) throw new Error("The workspace engine is not running.");
      return result;
    };
    return createOwnedWorkspaceSdkReads({
      workspace,
      files: dependencies.shareViewFiles,
      ...(databaseReader ? { databaseReader } : {}),
      listFiles: () => listOwnedWorkspaceFilesFor(workspace),
      collections: {
        // "No collections" is the honest empty answer without a capture;
        // the addressed reads below must name the missing capability instead.
        list: async () =>
          (await withEngineAdapter(
            dependencies.receivedShareEngine.workspaceForRegistered(workspace),
            async (adapter) => await adapter.listCollections(),
          )) ?? { collections: [] },
        get: ({ collectionPath }) =>
          collectionAdapter(
            async (adapter) => await adapter.getCollection({ collectionPath }),
          ),
        query: (params) =>
          collectionAdapter(
            async (adapter) => await adapter.queryCollectionRecords(params),
          ),
        getRecord: ({ collectionPath, recordId, historyLimit, beforeHistoryId }) =>
          collectionAdapter(
            async (adapter) =>
              await adapter.getCollectionRecord({
                collectionPath,
                recordId,
                historyLimit,
                ...(beforeHistoryId === undefined ? {} : { beforeHistoryId }),
              }),
          ),
      },
      repairProjection: (target) =>
        dependencies.ensureOwnedProjectionTargetCurrent({
          rootPath: workspace.rootPath,
          target,
        }),
      onSearchSourceFailure: (source, error) =>
        console.error(
          `[desktop] could not prepare ${source.prefix ?? "the shared view"} for an owned workspace read`,
          error,
        ),
    });
  }

  return {
    shareViewFilesTargetForPath,
    readOwnedWorkspaceText,
    readOwnedWorkspaceTextFor,
    readOwnedWorkspaceAsset,
    readOwnedWorkspaceAssetFor,
    listOwnedWorkspaceFilesFor,
    ownedWorkspaceReadsFor,
  };
}
