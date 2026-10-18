import type { WorkspacePathListing } from "../ipc/bridgeContract";
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
import { matchesFileListingScope, type WorkspaceFileListingScope } from "./workspaceFileListingScope";

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
    if (shareViewIsPresent(workspace.shareView)) {
      await dependencies.desktopEngine.startup;
      return dependencies.shareViewFiles.lookup({ kind: "standalone", workspaceId: workspace.workspaceId }, paths);
    }
    const files: Awaited<ReturnType<typeof listFiles>>["files"] = [];
    const local: string[] = [];
    const hasMountRegistry = shareMountRegistryIsPresent(workspace);
    const mounts = storedShareMounts(workspace);
    const routed = new Map<string, { paths: string[]; prefix: string }>();
    for (const path of paths) {
      if (hasMountRegistry) {
        let projection;
        try { projection = classifyResolvedShareProjectionPath(path, mounts); }
        catch { continue; }
        if (projection.kind === "projection-root") continue;
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

  function scoped(listed: WorkspacePathListing, scope?: WorkspaceFileListingScope) {
    return {
      files: listed.files.filter(file => matchesFileListingScope(file.path, scope)),
      folders: (listed.folders ?? []).filter(path => matchesFileListingScope(path, scope)),
    };
  }

  async function listCanonicalFiles(target: ShareViewFilesTarget, path?: string) {
    const under = path && path !== "." ? path : undefined;
    const listed = await dependencies.shareViewFiles.list(target, {
      includeContentIdentity: true,
      ...(under === undefined ? {} : { under }),
    });
    // Engine subtree listings omit a file whose path equals the scope. That
    // file comes from a lookup, so it has no content identity or icon.
    if (under !== undefined && listed.files.length === 0) {
      const exact = await dependencies.shareViewFiles.lookup(target, [under]);
      listed.files.push(...exact.files);
    }
    return listed;
  }

  async function listOwnedWorkspaceFilesFor(
    workspace: RegistryEntry & { readonly attachmentId: symbol },
    scope?: WorkspaceFileListingScope,
  ) {
    if (shareViewIsPresent(workspace.shareView)) {
      // The shell lists at mount, which can precede the daemon handshake now
      // that the window loads during it; the share store needs sessions. A
      // plain workspace's disk listing below stays ungated on purpose.
      await dependencies.desktopEngine.startup;
      return scoped(await listCanonicalFiles({ kind: "standalone", workspaceId: workspace.workspaceId }, scope?.path), scope);
    }
    const mounts = storedShareMounts(workspace);
    const disk = await (dependencies.listDiskFiles ?? listFiles)(workspace.rootPath, {
      includeContentIdentity: true,
      ...scope,
    });
    if (!shareMountRegistryIsPresent(workspace)) return disk;
    await dependencies.desktopEngine.startup;
    const overlaid = await overlayCanonicalShareMountFiles({
      disk,
      mounts,
      listCanonical: (mount) => {
        const prefix = `shared-with-me/${mount.label}`;
        const path = scope?.path;
        if (path && path !== "." && path !== prefix && !path.startsWith(prefix + "/") && !prefix.startsWith(path + "/")) {
          return Promise.resolve({ files: [], folders: [] });
        }
        return listCanonicalFiles(
          {
            kind: "mount",
            workspaceId: workspace.workspaceId,
            shareId: mount.shareId,
          },
          path?.startsWith(prefix + "/") ? path.slice(prefix.length + 1) : undefined,
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
    return scoped(overlaid, scope);
  }

  function ownedWorkspaceReadsFor(
    workspace: RegistryEntry & { readonly attachmentId: symbol },
  ) {
    return createOwnedWorkspaceReads({
      workspace,
      listFiles: (scope) => listOwnedWorkspaceFilesFor(workspace, scope),
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
