import { RelayShareCopyResult, ShareCopyResult, type ShareCopyInput } from "@dohc/workspace-contracts/share-copy";
import { assertOriginalWorkspace, createOwnerRelayShareHandler, OWNER_RELAY_SHARE_INACTIVE_MESSAGE } from "./ownerRelayShareHandler";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { buildShareCode } from "../workspaces/syncCode";

export function createShareCopyHandler<Sender, Workspace extends { workspaceId: string; shareView?: unknown },
  Operation extends { workspace: Workspace; assertCurrent(): void }>(dependencies: {
  currentSession(sender: Sender): { workspaceId: string } | null;
  withRendererWorkspaceOperation<Result>(sender: Sender, workspaceId: string, message: string, work: (operation: Operation) => Promise<Result>): Promise<Result>;
  remoteForWorkspace(workspace: Workspace): Promise<{ credentials: CloudCredentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  relayJson(credentials: CloudCredentials, path: string): Promise<unknown>;
}) {
  const ownerRelayShareHandler = createOwnerRelayShareHandler<Sender, Workspace, Operation, CloudCredentials>({
    withWorkspaceOperation: dependencies.withRendererWorkspaceOperation,
    remoteForWorkspace: dependencies.remoteForWorkspace,
    credentialGeneration: dependencies.currentCredentialGeneration,
  });
  return async (sender: Sender, input: ShareCopyInput): Promise<ShareCopyResult> => {
    const workspaceId = dependencies.currentSession(sender)?.workspaceId;
    if (!workspaceId) throw new Error(OWNER_RELAY_SHARE_INACTIVE_MESSAGE);
    return ownerRelayShareHandler(sender, workspaceId, async (operation, credentials, session) => {
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
    }, assertOriginalWorkspace);
  };
}
