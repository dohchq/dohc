import type { workspaceTrustOperations } from "./bridgeContract";
import type { OperationHandlers } from "./operationTable";
import type { TrustedFolder, WorkspaceTrust } from "../workspaces/workspaceTrust";

// What is still running leads, because it is the fact that matters for safety.
const STILL_RUNNING = {
  app: "An app in this workspace is still running",
  agent: "An agent in this workspace is still running",
  both: "An app and an agent in this workspace are still running",
};
const SAVE_FAILED = "dohc could not save Restricted Mode";
const SAVE_NEXT = "Try again before you quit dohc, or this workspace will be trusted again after a restart.";

// Why a restrict failed, or null when it did not.
export function restrictFailure(stillRunning: keyof typeof STILL_RUNNING | null, saveFailed: boolean): string | null {
  if (!stillRunning) return saveFailed ? `${SAVE_FAILED}. ${SAVE_NEXT}` : null;
  const running = STILL_RUNNING[stillRunning];
  if (saveFailed) return `${running}, and ${SAVE_FAILED}. ${SAVE_NEXT}`;
  return `${running}. dohc could not stop ${stillRunning === "both" ? "them" : "it"}.`;
}
export const STOP_FAILED_MESSAGE = restrictFailure("app", false)!;
export const SAVE_FAILED_MESSAGE = restrictFailure(null, true)!;
export const STOP_AND_SAVE_FAILED_MESSAGE = restrictFailure("app", true)!;

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
  // Stops the workspace's agent. Rejects when its runner did not stop.
  stopAgents(workspaceId: string): Promise<void>;
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
      const [apps, agents] = await Promise.allSettled([
        dependencies.stopAppCommands(operation),
        dependencies.stopAgents(workspaceId),
      ]);
      if (apps.status === "rejected") {
        console.warn("[desktop] could not stop a restricted workspace's app commands", apps.reason);
      }
      if (agents.status === "rejected") {
        console.warn("[desktop] could not stop a restricted workspace's agent", agents.reason);
      }
      // Windows start their static previews again, unless a Trust the
      // person gave meanwhile already told them otherwise.
      if (trust.isRevoked(workspaceId)) dependencies.notifyChanged(workspaceId, false);
      const stillRunning = apps.status === "rejected"
        ? agents.status === "rejected" ? "both" : "app"
        : agents.status === "rejected" ? "agent" : null;
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
      const failure = restrictFailure(stillRunning, saveFailed);
      if (failure) throw new Error(failure);
      return { workspaceId, trusted: false };
    },
  };
}
