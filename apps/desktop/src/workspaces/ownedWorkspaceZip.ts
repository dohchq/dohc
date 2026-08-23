import { isSharedWithMePath } from "@dohc/workspace-core";
import { basename } from "node:path";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import {
  resolveShareProjectionPath,
  usableShareMountRecord,
} from "./shareMounts";
import type { ShareViewFilesTarget } from "./shareViewFiles";
import {
  shareMountRegistryIsPresent,
  storedShareMounts,
  type ShareViewFilesWorkspaceRecord,
} from "./shareViewFilesTarget";
import { shareViewIsPresent } from "./shareViewMarker";
import {
  collectZipEntries,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_TOTAL_BYTES,
  ZIP_TOO_LARGE_REFUSAL,
} from "./workspaceFiles";
import type { ZipEntry } from "./zipWriter";

export type OwnedZipSelection =
  | { kind: "workspace-root"; archiveRoot: string | null }
  | { kind: "projection-root"; archiveRoot: string }
  | { kind: "local" };

/**
 * Map one resolved export selection into its raw-cache exclusion and the
 * archive path where each canonical mount belongs.
 *
 * The selected spelling can be a symlink alias. Archive entry names preserve
 * that spelling, so deciding ownership from those names would miss an alias
 * to either the workspace root or shared-with-me. The resolved selection is
 * the authority; archive names only decide presentation.
 */
export function ownedZipProjectionPlan(selection: OwnedZipSelection): {
  includesMounts: boolean;
  keepDiskEntry(path: string): boolean;
  mountArchivePrefix(label: string): string | null;
} {
  if (selection.kind === "local") {
    return {
      includesMounts: false,
      keepDiskEntry: () => true,
      mountArchivePrefix: () => null,
    };
  }
  if (selection.kind === "projection-root") {
    return {
      includesMounts: true,
      keepDiskEntry: () => false,
      mountArchivePrefix: (label) => `${selection.archiveRoot}/${label}`,
    };
  }

  const archivePrefix =
    selection.archiveRoot === null ? "" : `${selection.archiveRoot}/`;
  return {
    includesMounts: true,
    keepDiskEntry: (path) => {
      const workspacePath =
        archivePrefix !== "" && path.startsWith(archivePrefix)
          ? path.slice(archivePrefix.length)
          : path;
      return !isSharedWithMePath(workspacePath);
    },
    mountArchivePrefix: (label) =>
      `${archivePrefix}${SHARED_WITH_ME_FOLDER}/${label}`,
  };
}

export interface OwnedZipShareRequest {
  target: ShareViewFilesTarget;
  rootName: string;
  relativePath?: string;
}

/**
 * Export a workspace through its current file owners.
 *
 * Disk collection sees the projection exclusion before it opens a file. The
 * canonical share collector then supplies every received-share entry. Keeping
 * path resolution and both collectors in this module makes aliases and an
 * empty registry tombstone follow the same ownership rule as ordinary paths.
 */
export async function collectOwnedWorkspaceZipEntries(input: {
  workspace: ShareViewFilesWorkspaceRecord;
  relativePath?: string;
  collectShare(
    request: OwnedZipShareRequest,
  ): Promise<{ entries: ZipEntry[]; baseName: string }>;
}): Promise<{ entries: ZipEntry[]; baseName: string }> {
  const { workspace } = input;
  if (shareViewIsPresent(workspace.shareView)) {
    return input.collectShare({
      target: { kind: "standalone", workspaceId: workspace.workspaceId },
      rootName: basename(workspace.rootPath),
      ...(input.relativePath === undefined
        ? {}
        : { relativePath: input.relativePath }),
    });
  }

  const mounts = storedShareMounts(workspace);
  const hasMountRegistry = shareMountRegistryIsPresent(workspace);
  let selection: OwnedZipSelection = {
    kind: "workspace-root",
    archiveRoot: null,
  };
  if (input.relativePath !== undefined) {
    selection = { kind: "local" };
    if (hasMountRegistry) {
      const resolved = await resolveShareProjectionPath(
        workspace.rootPath,
        input.relativePath,
        mounts,
      );
      if (resolved.kind === "mount") {
        return input.collectShare({
          target: {
            kind: "mount",
            workspaceId: workspace.workspaceId,
            shareId: resolved.mount.shareId,
          },
          rootName: basename(input.relativePath),
          ...(resolved.path === "" ? {} : { relativePath: resolved.path }),
        });
      }
      const archiveRoot = basename(input.relativePath);
      if (resolved.kind === "workspace-root") {
        selection = { kind: "workspace-root", archiveRoot };
      } else if (resolved.kind === "projection-root") {
        selection = { kind: "projection-root", archiveRoot };
      }
    }
  }

  const projection = hasMountRegistry
    ? ownedZipProjectionPlan(selection)
    : null;
  const disk =
    selection.kind === "projection-root"
      ? {
          entries: [],
          baseName:
            selection.archiveRoot.replace(/\.[^.]+$/, "") ||
            selection.archiveRoot,
        }
      : await collectZipEntries(
          workspace.rootPath,
          input.relativePath,
          projection === null
            ? undefined
            : { includeArchivePath: projection.keepDiskEntry },
        );
  if (projection === null) return disk;

  const entries = disk.entries;
  if (projection.includesMounts) {
    for (const mount of mounts) {
      if (!usableShareMountRecord(mounts, mount)) continue;
      const archivePrefix = projection.mountArchivePrefix(mount.label);
      if (archivePrefix === null) continue;
      const canonical = await input.collectShare({
        target: {
          kind: "mount",
          workspaceId: workspace.workspaceId,
          shareId: mount.shareId,
        },
        rootName: mount.label,
      });
      entries.push(
        ...canonical.entries.map((entry) => ({
          ...entry,
          path: `${archivePrefix}/${entry.path}`,
        })),
      );
    }
  }
  const totalBytes = entries.reduce(
    (total, entry) => total + entry.data.byteLength,
    0,
  );
  if (entries.length > MAX_ZIP_ENTRIES || totalBytes > MAX_ZIP_TOTAL_BYTES) {
    throw new Error(ZIP_TOO_LARGE_REFUSAL);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries, baseName: disk.baseName };
}
