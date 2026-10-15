import { credentialScopedOperation } from "../workspaces/credentialScopedOperation";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";

export const OWNER_RELAY_SHARE_INACTIVE_MESSAGE = "Sharing stopped because this window changed workspaces.";

export function assertOriginalWorkspace(workspace: { shareView?: unknown }): void {
  if (shareViewIsPresent(workspace.shareView)) {
    throw new Error("This is a shared view — only the original workspace can be shared.");
  }
}

type OwnerRelayShareDependencies<Workspace, Credentials> = {
  remoteForWorkspace(workspace: Workspace): Promise<{
    credentials: Credentials;
    credentialGeneration: number;
  }>;
  credentialGeneration(): number;
};

export function createOwnerRelayShareOperation<
  Workspace,
  Operation extends { workspace: Workspace; assertCurrent(): void },
  Credentials,
>(dependencies: OwnerRelayShareDependencies<Workspace, Credentials>) {
  return async function ownerRelayShareOperation<Result>(
    operation: Operation,
    work: (
      operation: Operation,
      credentials: Credentials,
      session: ReturnType<typeof credentialScopedOperation>,
    ) => Promise<Result>,
    assertWorkspace?: (workspace: Workspace) => void,
  ): Promise<Result> {
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
  };
}

export function createOwnerRelayShareHandler<
  Sender,
  Workspace,
  Operation extends { workspace: Workspace; assertCurrent(): void },
  Credentials,
>(dependencies: OwnerRelayShareDependencies<Workspace, Credentials> & {
  withWorkspaceOperation<Result>(
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
}) {
  const read = createOwnerRelayShareOperation<Workspace, Operation, Credentials>(dependencies);
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
      OWNER_RELAY_SHARE_INACTIVE_MESSAGE,
      operation => read(operation, work, assertWorkspace),
    );
  };
}
