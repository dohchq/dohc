import { isSharedWithMePath } from "@dohc/workspace-core";
import type { OperationHandlers } from "./operationTable";
import type { explorerMenuOperations } from "./explorerMenuOperations";
import { explorerMenuEntries, type ExplorerMenuScope } from "../workspaces/explorerMenu";
import { storedShareMounts } from "../workspaces/shareViewFilesTarget";
import { usableShareMountRecord } from "../workspaces/shareMounts";
import { resolveWorkspaceFile } from "../workspaces/workspaceAssets";
import type { RegistryEntry } from "../workspaces/registryStore";

export function createExplorerMenuIpc<
  Event,
  Workspace extends RegistryEntry,
  Operation extends { workspace: Workspace; assertCurrent(): void },
>(dependencies: {
  sharedViewOf(workspaceId: string): ExplorerMenuScope["shareView"];
  ensureOwnedProjectionCurrent(workspace: Workspace, path: string): Promise<void>;
  shell: { showItemInFolder(path: string): void };
  platform: string;
}) {
  const { sharedViewOf, ensureOwnedProjectionCurrent, shell, platform } = dependencies;
  return {
    // The scope is read from main's own records: the share view this
    // workspace is, its mounts, and whether it syncs. The renderer names only
    // what was right-clicked.
    readExplorerMenu: (input, { operation }) => {
      const workspace = operation.workspace;
      const shareView = sharedViewOf(workspace.workspaceId);
      const isMountPath = shareView === null && !!input.path && isSharedWithMePath(input.path);
      const mounts = isMountPath ? storedShareMounts(workspace) : [];
      const hasMountRecord = mounts.some(
        (mount) => usableShareMountRecord(mounts, mount) && input.path === `shared-with-me/${mount.label}`,
      );
      return explorerMenuEntries({
        kind: input.kind,
        pinned: input.pinned,
        isMountPath,
        hasMountRecord,
        // Sharing onward is offered nowhere in a share view or a mount:
        // someone else's files are not this account's to grant. A workspace
        // that does not sync still offers it, as the toolbar does, and the
        // dialog says how to set up sync.
        canShare: shareView === null && !isMountPath && input.kind !== "root",
        shareView,
      }, platform);
    },

    // Containment before the OS sees the path (resolveWorkspaceFile:
    // validate + realpath + inside-root), the same rule as openFileExternally.
    revealExplorerPath: async (input, { operation }) => {
      await ensureOwnedProjectionCurrent(operation.workspace, input.path);
      const { realTarget } = await resolveWorkspaceFile(operation.workspace.rootPath, input.path, "read");
      operation.assertCurrent();
      shell.showItemInFolder(realTarget);
    },
  } satisfies OperationHandlers<typeof explorerMenuOperations, Event, Operation>;
}
