import type { workspaceTrustOperations } from "./bridgeContract";
import type { OperationHandlers } from "./operationTable";
import type { TrustedFolder, WorkspaceTrust } from "../workspaces/workspaceTrust";

// Main's side of workspace trust. The renderer can read it, ask for main's
// dialog, and give trust up; only the person's answer in the dialog grants it.
export function workspaceTrustHandlers<
  Event,
  Operation extends { readonly workspace: TrustedFolder; assertCurrent(): void },
>(dependencies: {
  trust: Pick<WorkspaceTrust, "isTrusted" | "trust" | "restrict">;
  isSharedView(workspaceId: string): boolean;
  // Main's dialog, over the window that asked. True only on Trust workspace.
  confirm(event: Event, workspace: TrustedFolder): Promise<boolean>;
  // Stops every app command the workspace runs, and its previews.
  stopAppCommands(operation: Operation): Promise<void>;
  notifyChanged(workspaceId: string, trusted: boolean): void;
}): OperationHandlers<typeof workspaceTrustOperations, Event, Operation> {
  const { trust } = dependencies;
  return {
    readWorkspaceTrust: async (_input, { operation }) => ({
      workspaceId: operation.workspace.workspaceId,
      trusted: await trust.isTrusted(operation.workspace),
    }),
    requestWorkspaceTrust: async (_input, { event, operation }) => {
      const { workspace } = operation;
      if (dependencies.isSharedView(workspace.workspaceId)) {
        throw new Error("A shared view shows apps through the static preview only.");
      }
      if (await trust.isTrusted(workspace)) return { workspaceId: workspace.workspaceId, trusted: true };
      if (!(await dependencies.confirm(event, workspace))) {
        return { workspaceId: workspace.workspaceId, trusted: false };
      }
      // The dialog can outlast the window's workspace.
      operation.assertCurrent();
      await trust.trust(workspace);
      dependencies.notifyChanged(workspace.workspaceId, true);
      return { workspaceId: workspace.workspaceId, trusted: true };
    },
    restrictWorkspace: async (_input, { operation }) => {
      const { workspaceId } = operation.workspace;
      await trust.restrict(workspaceId);
      // What already runs stops too. Windows start their static previews again.
      await dependencies.stopAppCommands(operation);
      dependencies.notifyChanged(workspaceId, false);
      return { workspaceId, trusted: false };
    },
  };
}
