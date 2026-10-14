import { credentialScopedOperation } from "../workspaces/credentialScopedOperation";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";

export const OWNER_RELAY_SHARE_INACTIVE_MESSAGE = "Sharing stopped because this window changed workspaces.";

export function assertOriginalWorkspace(workspace: { shareView?: unknown }): void {
  if (shareViewIsPresent(workspace.shareView)) {
    throw new Error("This is a shared view — only the original workspace can be shared.");
  }
}

export function createOwnerRelayShareHandler<
  Sender,
  Workspace,
  Operation extends { workspace: Workspace; assertCurrent(): void },
  Credentials,
>(dependencies: {
  withWorkspaceOperation<Result>(
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  remoteForWorkspace(workspace: Workspace, options?: { allowPaused: boolean }): Promise<{
    credentials: Credentials;
    credentialGeneration: number;
  }>;
  credentialGeneration(): number;
}) {
  return function ownerRelayShareHandler<Result>(
    sender: Sender,
    workspaceId: string,
    work: (
      operation: Operation,
      credentials: Credentials,
      session: ReturnType<typeof credentialScopedOperation>,
    ) => Promise<Result>,
    assertWorkspace?: (workspace: Workspace) => void,
    options?: { allowPaused: boolean },
  ): Promise<Result> {
    return dependencies.withWorkspaceOperation(
      sender,
      workspaceId,
      OWNER_RELAY_SHARE_INACTIVE_MESSAGE,
      async (operation) => {
        operation.assertCurrent();
        assertWorkspace?.(operation.workspace);
        const { credentials, credentialGeneration } =
          await dependencies.remoteForWorkspace(operation.workspace, options);
        const session = credentialScopedOperation({
          assertCurrent: () => operation.assertCurrent(),
          capturedGeneration: credentialGeneration,
          currentGeneration: dependencies.credentialGeneration,
        });
        session.assertCurrent();
        return work(operation, credentials, session);
      },
    );
  };
}
