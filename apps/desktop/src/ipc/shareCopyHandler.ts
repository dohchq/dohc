import { RelayShareCopyResult, ShareCopyResult, type ShareCopyInput } from "@dohc/workspace-contracts/share-copy";
import { credentialScopedOperation } from "../workspaces/credentialScopedOperation";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { buildShareCode } from "../workspaces/syncCode";

export function createShareCopyHandler<Sender, Workspace extends { workspaceId: string; shareView?: unknown },
  Operation extends { workspace: Workspace; assertCurrent(): void }>(dependencies: {
  currentSession(sender: Sender): { workspaceId: string; isCurrent(): boolean } | null;
  withRendererWorkspaceOperation<Result>(sender: Sender, workspaceId: string, message: string, work: (operation: Operation) => Promise<Result>): Promise<Result>;
  remoteForWorkspace(workspace: Workspace): Promise<{ credentials: CloudCredentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  relayJson(credentials: CloudCredentials, path: string): Promise<unknown>;
}) {
  return async (sender: Sender, input: ShareCopyInput): Promise<ShareCopyResult> => {
    const message = "Sharing stopped because this window changed workspaces.";
    const windowSession = dependencies.currentSession(sender);
    if (!windowSession || !windowSession.isCurrent()) throw new Error(message);
    return dependencies.withRendererWorkspaceOperation(sender, windowSession.workspaceId, message, async operation => {
      const assertCurrent = () => {
        operation.assertCurrent();
        if (!windowSession.isCurrent()) throw new Error(message);
      };
      assertCurrent();
      if (shareViewIsPresent(operation.workspace.shareView)) throw new Error("This is a shared view — only the original workspace can be shared.");
      const { credentials, credentialGeneration } = await dependencies.remoteForWorkspace(operation.workspace);
      const session = credentialScopedOperation({ assertCurrent, capturedGeneration: credentialGeneration,
        currentGeneration: dependencies.currentCredentialGeneration });
      const workspaceId = operation.workspace.workspaceId;
      const result = RelayShareCopyResult.parse(await session.run(() => dependencies.relayJson(credentials,
        `/sync/${encodeURIComponent(workspaceId)}/shares/${encodeURIComponent(input.shareId)}/grants/${encodeURIComponent(input.grantId)}/copy`)));
      if (result.workspaceId !== workspaceId || result.shareId !== input.shareId || result.grantId !== input.grantId) {
        throw new Error("The share changed. Refresh Sharing and try again.");
      }
      return ShareCopyResult.parse(result.status === "ended" ? { status: "ended" } : {
        status: "active", shareCode: buildShareCode({ shareId: input.shareId, relayUrl: credentials.relayUrl! }),
        ...(result.browserInvitationUrl ? { browserInvitationUrl: result.browserInvitationUrl } : {}),
      });
    });
  };
}
