import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import { resolveWorkspaceRelayAuthorId } from "../workspaces/chatRelayIdentity";
import type { RegistryEntry } from "../workspaces/registryStore";

export function mcpCloudEnvironment(input: {
  workspace: Pick<RegistryEntry, "remote"> | undefined;
  credentials: CloudCredentials | null;
}): Record<string, string> | undefined {
  if (
    !input.workspace ||
    !input.credentials ||
    resolveWorkspaceRelayAuthorId(input.workspace, input.credentials) === undefined
  ) {
    return;
  }
  return {
    DOHC_MCP_CLOUD_SERVER_URL: input.credentials.serverUrl,
    DOHC_MCP_CLOUD_USER_ID: input.credentials.userId,
  };
}
