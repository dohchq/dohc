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
  // The dialog was shown for the workspace, whatever the answer.
  onAsk?(workspaceId: string): void;
  // Whether it was shown since the workspace's trust last changed.
  wasAsked?(workspaceId: string): boolean;
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
    const trusted = await dependencies.confirm(event, workspace);
    dependencies.onAsk?.(workspace.workspaceId);
    if (!trusted) return;
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
    requestWorkspaceTrust: async (input, { event, operation }) => {
      const { workspace } = operation;
      const { workspaceId } = workspace;
      if (dependencies.isSharedView(workspaceId)) {
        throw new Error("A shared view shows apps through the static preview only.");
      }
      if (!(await trust.isTrusted(workspace))) {
        let answer = asking.get(workspaceId);
        // A question a send asked for automatically opens only until it
        // was shown; Trust workspace the person clicks always opens it.
        if (!answer && !(input.automatic && dependencies.wasAsked?.(workspaceId))) {
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
      // The save starts with the stops, so quitting while an agent takes its
      // time to exit still leaves the workspace restricted. Saves wait in
      // line with Trust's writes and skip when a Trust replaced this.
      const failed = (work: Promise<void>, what: string) => work.then(() => false, (error: unknown) => {
        console.warn(`[desktop] could not ${what}`, error);
        return true;
      });
      const early = trust.persistRevocation(workspaceId).catch(() => undefined);
      const agentsFailing = failed(dependencies.stopAgents(workspaceId), "stop a restricted workspace's agent");
      const appsFailed = await failed(dependencies.stopAppCommands(operation), "stop a restricted workspace's app commands");
      // Windows start their static previews again, unless a Trust the
      // person gave meanwhile already told them otherwise.
      if (trust.isRevoked(workspaceId)) dependencies.notifyChanged(workspaceId, false);
      const agentsFailed = await agentsFailing;
      await early;
      // Saving again lines up behind a Trust that is still writing, and
      // tries once more when the first save failed.
      const saveFailed = await failed(trust.persistRevocation(workspaceId), "save Restricted Mode");
      // A Trust given meanwhile replaces this restrict. Apps and agents that
      // started since belong to the trusted workspace, so a stop that counted
      // them is not a failure, and the save skipped.
      if (!trust.isRevoked(workspaceId)) return { workspaceId, trusted: true };
      const failure = restrictFailure(
        appsFailed ? agentsFailed ? "both" : "app" : agentsFailed ? "agent" : null,
        saveFailed,
      );
      if (failure) throw new Error(failure);
      return { workspaceId, trusted: false };
    },
  };
}
