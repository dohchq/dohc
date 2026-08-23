import { isSharedWithMePath } from "@dohc/workspace-core";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";

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
