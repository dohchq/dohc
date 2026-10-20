import type { workspaceTrustOperations } from "./bridgeContract";
import type { OperationHandlers } from "./operationTable";
import type { TrustedFolder, WorkspaceTrust } from "../workspaces/workspaceTrust";

// The running app leads, because it is the fact that matters for safety.
export const STOP_FAILED_MESSAGE = "An app in this workspace is still running. dohc could not stop it.";
export const SAVE_FAILED_MESSAGE =
  "dohc could not save Restricted Mode. Try again before you quit dohc, or this workspace will be trusted again after a restart.";
export const STOP_AND_SAVE_FAILED_MESSAGE =
  "An app in this workspace is still running, and dohc could not save Restricted Mode. Try again before you quit dohc, or this workspace will be trusted again after a restart.";

// Main's side of workspace trust. The renderer can read it, ask for main's
// dialog, and give trust up; only the person's answer in the dialog grants it.
export function workspaceTrustHandlers<
  Event,
  Operation extends { readonly workspace: TrustedFolder; assertCurrent(): void },
>(dependencies: {
  trust: Pick<WorkspaceTrust, "isTrusted" | "trust" | "revoke" | "persistRevocation" | "isRevoked">;
  // The folder now at a path, by identity.
  identify(rootPath: string): Promise<string | null>;
  isSharedView(workspaceId: string): boolean;
  // Main's dialog, over the window that asked. True only on Trust workspace.
  confirm(event: Event, workspace: TrustedFolder): Promise<boolean>;
  // Stops every app command the workspace runs, and its previews. Rejects
  // when one did not stop.
  stopAppCommands(operation: Operation): Promise<void>;
  notifyChanged(workspaceId: string, trusted: boolean): void;
}): OperationHandlers<typeof workspaceTrustOperations, Event, Operation> {
  const { trust } = dependencies;
  // One dialog per workspace. A second request waits for the first answer.
  const asking = new Map<string, Promise<void>>();

  async function askAndTrust(event: Event, operation: Operation): Promise<void> {
    const { workspace } = operation;
    // The grant names the folder the person was asked about. A folder put at
    // the path while the dialog was open does not match it.
    const folder = await dependencies.identify(workspace.rootPath);
    if (!(await dependencies.confirm(event, workspace))) return;
    // The dialog can outlast the window's workspace.
    operation.assertCurrent();
    if (!(await trust.trust(workspace, { folder }))) return;
    if (await trust.isTrusted(workspace)) dependencies.notifyChanged(workspace.workspaceId, true);
  }

  return {
    readWorkspaceTrust: async (_input, { operation }) => ({
      workspaceId: operation.workspace.workspaceId,
      trusted: await trust.isTrusted(operation.workspace),
    }),
    requestWorkspaceTrust: async (_input, { event, operation }) => {
      const { workspace } = operation;
      const { workspaceId } = workspace;
      if (dependencies.isSharedView(workspaceId)) {
        throw new Error("A shared view shows apps through the static preview only.");
      }
      if (!(await trust.isTrusted(workspace))) {
        let answer = asking.get(workspaceId);
        if (!answer) {
          answer = askAndTrust(event, operation).finally(() => asking.delete(workspaceId));
          asking.set(workspaceId, answer);
        }
        await answer;
      }
      return { workspaceId, trusted: await trust.isTrusted(workspace) };
    },
    // Fails closed: the workspace is restricted before anything can fail, its
    // commands stop whatever the file write does, and either failure is
    // reported, so the person can try again.
    restrictWorkspace: async (_input, { operation }) => {
      const { workspaceId } = operation.workspace;
      trust.revoke(workspaceId);
      let stopFailed = false;
      try {
        await dependencies.stopAppCommands(operation);
      } catch (error) {
        console.warn("[desktop] could not stop a restricted workspace's app commands", error);
        stopFailed = true;
      } finally {
        // Windows start their static previews again, unless a Trust the
        // person gave meanwhile already told them otherwise.
        if (trust.isRevoked(workspaceId)) dependencies.notifyChanged(workspaceId, false);
      }
      // A Trust given meanwhile replaces this restrict. Apps that started
      // since belong to the trusted workspace, so a stop that counted them
      // is not a failure, and there is nothing to save.
      if (!trust.isRevoked(workspaceId)) return { workspaceId, trusted: true };
      let saveFailed = false;
      try {
        await trust.persistRevocation(workspaceId);
      } catch (error) {
        console.warn("[desktop] could not save Restricted Mode", error);
        saveFailed = true;
      }
      // The save can wait behind a Trust's write and then skip, so ask again.
      if (!trust.isRevoked(workspaceId)) return { workspaceId, trusted: true };
      if (stopFailed && saveFailed) throw new Error(STOP_AND_SAVE_FAILED_MESSAGE);
      if (stopFailed) throw new Error(STOP_FAILED_MESSAGE);
      if (saveFailed) throw new Error(SAVE_FAILED_MESSAGE);
      return { workspaceId, trusted: false };
    },
  };
}
