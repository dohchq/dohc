import type {
  WorkspaceSecretsState,
  WorkspaceSecretWriteInput,
} from "@dohc/workspace-contracts/workspace-secrets";
import type { OperationHandlers } from "./operationTable";
import { workspaceSecretsOperations } from "./workspaceSecretsOperations";

export function workspaceSecretsHandlers<Sender, Event extends { sender: Sender }>(dependencies: {
  currentRendererSession(sender: Sender): { readonly workspaceId: string } | undefined;
  listWorkspaceSecrets(workspaceId: string): Promise<WorkspaceSecretsState>;
  setWorkspaceSecret(
    workspaceId: string,
    secret: WorkspaceSecretWriteInput,
  ): Promise<WorkspaceSecretsState>;
  deleteWorkspaceSecret(workspaceId: string, name: string): Promise<WorkspaceSecretsState>;
  clearLocalWorkspaceSecrets(workspaceId: string): Promise<WorkspaceSecretsState>;
}): OperationHandlers<typeof workspaceSecretsOperations, Event> {
  const admit = (event: Event, workspaceId: string) => {
    if (dependencies.currentRendererSession(event.sender)?.workspaceId !== workspaceId) {
      throw new Error("This workspace is no longer active.");
    }
  };
  return {
    listWorkspaceSecrets: (input, { event }) => {
      admit(event, input.workspaceId);
      return dependencies.listWorkspaceSecrets(input.workspaceId);
    },
    setWorkspaceSecret: (input, { event }) => {
      admit(event, input.workspaceId);
      return dependencies.setWorkspaceSecret(input.workspaceId, input.secret);
    },
    deleteWorkspaceSecret: (input, { event }) => {
      admit(event, input.workspaceId);
      return dependencies.deleteWorkspaceSecret(input.workspaceId, input.name);
    },
    clearLocalWorkspaceSecrets: (input, { event }) => {
      admit(event, input.workspaceId);
      return dependencies.clearLocalWorkspaceSecrets(input.workspaceId);
    },
  };
}
