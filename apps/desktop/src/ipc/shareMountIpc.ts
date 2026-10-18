import type { WorkspaceSummary } from "./bridgeContract";
import type { shareMountOperations } from "./shareOperations";
import type { OperationHandlers } from "./operationTable";
import type {
  ShareMountCommandWorkspace,
  ShareMountCommands,
} from "../workspaces/shareMountCommands";

type ShareMountOperation<Workspace> = {
  readonly workspace: Workspace;
  assertCurrent(): void;
};

export function createShareMountIpcHandlers<Workspace extends ShareMountCommandWorkspace>(dependencies: {
  assertWritableWorkspace(workspace: Workspace): void;
  commands: Pick<ShareMountCommands<WorkspaceSummary>, "mount" | "refresh" | "unmount">;
}): OperationHandlers<typeof shareMountOperations, unknown, ShareMountOperation<Workspace>> {
  return {
    mountShare: async (input, { operation }) => {
      dependencies.assertWritableWorkspace(operation.workspace);
      return dependencies.commands.mount({
        workspace: operation.workspace,
        shareCode: input.shareCode,
        assertCurrent: operation.assertCurrent,
      });
    },
    refreshShareMounts: async (_input, { operation }) => {
      dependencies.assertWritableWorkspace(operation.workspace);
      return dependencies.commands.refresh({
        workspace: operation.workspace,
        assertCurrent: operation.assertCurrent,
      });
    },
    unmountShare: async (input, { operation }) => {
      dependencies.assertWritableWorkspace(operation.workspace);
      return dependencies.commands.unmount({
        workspace: operation.workspace,
        shareId: input.shareId,
        assertCurrent: operation.assertCurrent,
      });
    },
  };
}
