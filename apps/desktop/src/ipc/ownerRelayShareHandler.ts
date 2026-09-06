import { credentialScopedOperation } from "../workspaces/credentialScopedOperation";

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
  remoteForWorkspace(workspace: Workspace): Promise<{
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
  ): Promise<Result> {
    return dependencies.withWorkspaceOperation(
      sender,
      workspaceId,
      "Sharing stopped because this window changed workspaces.",
      async (operation) => {
        operation.assertCurrent();
        assertWorkspace?.(operation.workspace);
        const { credentials, credentialGeneration } =
          await dependencies.remoteForWorkspace(operation.workspace);
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
