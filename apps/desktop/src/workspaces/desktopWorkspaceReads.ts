import type { createDesktopEngine } from "./desktopEngine";
import type { createOwnedProjectionRepairer } from "./ownedProjectionRepair";
import { createOwnedWorkspaceFileReader } from "./ownedWorkspaceFileReader";
import { createOwnedWorkspaceReads } from "./ownedWorkspaceReads";
import type { RegistryEntry } from "./registryStore";
import { classifyResolvedShareProjectionPath, overlayCanonicalShareMountFiles } from "./shareMounts";
import type { ShareViewFiles, ShareViewFilesTarget } from "./shareViewFiles";
import { shareMountRegistryIsPresent, storedShareMounts } from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";
import type { WorkspaceAuthorityOperation } from "./workspaceAuthorityOwner";
import { listFiles } from "./workspaceFiles";
import type { WorkspaceFileListingScope } from "./workspaceFileListingScope";

export interface DesktopWorkspaceReadsDependencies {
  readonly desktopEngine: Pick<ReturnType<typeof createDesktopEngine>, "startup">;
  readonly shareViewFiles: Pick<ShareViewFiles, "read" | "list" | "lookup">;
  readonly ensureOwnedProjectionTargetCurrent: ReturnType<
    typeof createOwnedProjectionRepairer
  >;
  withPhysicalWorkspaceOperation<Result>(
    workspaceId: string,
    work: (
      operation: Pick<WorkspaceAuthorityOperation<RegistryEntry, unknown>, "workspace">,
    ) => Result | Promise<Result>,
  ): Promise<Result>;
  isRecordValue(value: unknown): value is Record<string, unknown>;
  listDiskFiles?: typeof listFiles;
}

export function createDesktopWorkspaceReads(dependencies: DesktopWorkspaceReadsDependencies) {
  const { withPhysicalWorkspaceOperation, isRecordValue } = dependencies;

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

  async function lookupOwnedWorkspaceFilesFor(
    workspace: RegistryEntry & { readonly attachmentId: symbol }, paths: readonly string[],
  ) {
    const files: Awaited<ReturnType<typeof listFiles>>["files"] = [];
    if (shareViewIsPresent(workspace.shareView)) {
      await dependencies.desktopEngine.startup;
      return dependencies.shareViewFiles.lookup({ kind: "standalone", workspaceId: workspace.workspaceId }, paths);
    }
    const local: string[] = [];
    const mounts = storedShareMounts(workspace);
    const routed = new Map<string, { paths: string[]; prefix: string }>();
    for (const path of paths) {
      if (shareMountRegistryIsPresent(workspace)) {
        let projection;
        try { projection = classifyResolvedShareProjectionPath(path, mounts); }
        catch { continue; }
        if (projection.kind === "mount") {
          const prefix = `shared-with-me/${projection.mount.label}/`;
          if (path !== prefix + projection.path) continue;
          const group = routed.get(projection.mount.shareId) ?? { paths: [], prefix };
          group.paths.push(projection.path);
          routed.set(projection.mount.shareId, group);
          continue;
        }
      }
      local.push(path);
    }
    if (local.length) files.push(...(await (dependencies.listDiskFiles ?? listFiles)(workspace.rootPath, { paths: local })).files);
    for (const [shareId, group] of routed) {
      await dependencies.desktopEngine.startup;
      const listed = await dependencies.shareViewFiles.lookup({ kind: "mount", workspaceId: workspace.workspaceId, shareId }, group.paths);
      files.push(...listed.files.map(file => ({ ...file, path: group.prefix + file.path })));
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, folders: [] };
  }

  async function listOwnedWorkspaceFilesFor(
    workspace: RegistryEntry & { readonly attachmentId: symbol },
    scope?: WorkspaceFileListingScope,
    bounded = false,
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
        { includeContentIdentity: true, ...(bounded && scope?.path && scope.path !== "." ? { under: scope.path } : {}) },
      );
    }
    const mounts = storedShareMounts(workspace);
    const disk = await (dependencies.listDiskFiles ?? listFiles)(workspace.rootPath, {
      includeContentIdentity: true,
      ...(bounded || !shareMountRegistryIsPresent(workspace) ? scope : {}),
    });
    if (!shareMountRegistryIsPresent(workspace)) return disk;
    await dependencies.desktopEngine.startup;
    return overlayCanonicalShareMountFiles({
      disk,
      mounts,
      listCanonical: (mount) => {
        const prefix = `shared-with-me/${mount.label}`;
        const path = bounded ? scope?.path : undefined;
        if (path && path !== "." && path !== prefix && !path.startsWith(prefix + "/") && !prefix.startsWith(path + "/")) {
          return Promise.resolve({ files: [], folders: [] });
        }
        return dependencies.shareViewFiles.list(
          {
            kind: "mount",
            workspaceId: workspace.workspaceId,
            shareId: mount.shareId,
          },
          { includeContentIdentity: true, ...(path?.startsWith(prefix + "/") ? { under: path.slice(prefix.length + 1) } : {}) },
        );
      },
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
  ) {
    return createOwnedWorkspaceReads({
      workspace,
      listFiles: (scope, bounded) => listOwnedWorkspaceFilesFor(workspace, scope, bounded),
      lookupFiles: (paths) => lookupOwnedWorkspaceFilesFor(workspace, paths),
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
    lookupOwnedWorkspaceFilesFor,
    listOwnedWorkspaceFilesFor,
    ownedWorkspaceReadsFor,
  };
}
