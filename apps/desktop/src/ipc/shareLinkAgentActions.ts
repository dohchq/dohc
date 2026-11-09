import {
  DisconnectRelayShareLinkAgentResult, ListRelayShareLinkAgentsResult,
  type ShareLinkAgentDisconnectInput, type ShareLinkAgentsInput,
} from "@dohc/workspace-contracts/share-link-agents";
import { RelayShareLinkAgentDisconnectResponse, RelayShareLinkAgentsResponse } from "./bridgeContract";
import { assertOriginalWorkspace, createOwnerRelayShareOperation } from "./ownerRelayShareHandler";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";

type AgentsWorkspace = { workspaceId: string; shareView?: unknown };
type AgentsOperation<Workspace> = { workspace: Workspace; assertCurrent(): void };
interface AgentsDependencies<Workspace> {
  remoteForWorkspace(workspace: Workspace): Promise<{ credentials: CloudCredentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  relayJson(credentials: CloudCredentials, path: string, init?: RequestInit): Promise<unknown>;
  relayShareErrorCopy(status: number, data: null): string;
}

/**
 * A link's Agents list and its Disconnect, for the Share dialog and for
 * agents alike. The relay answers only the owner of the share and its
 * workspace, for an active link on that share. Main names the workspace
 * the caller's operation holds.
 */
export function createShareLinkAgentActions<Workspace extends AgentsWorkspace>(dependencies: AgentsDependencies<Workspace>) {
  const ownerRelayShareOperation = createOwnerRelayShareOperation<Workspace, AgentsOperation<Workspace>, CloudCredentials>({
    remoteForWorkspace: dependencies.remoteForWorkspace,
    credentialGeneration: dependencies.currentCredentialGeneration,
  });
  const linkAgentsPath = (workspaceId: string, input: { shareId: string; grantId: string }) =>
    `/sync/${encodeURIComponent(workspaceId)}/shares/${encodeURIComponent(input.shareId)}/links/${encodeURIComponent(input.grantId)}/agents`;
  const invalidReply = () => new Error(dependencies.relayShareErrorCopy(500, null));

  return {
    list: (operation: AgentsOperation<Workspace>, input: ShareLinkAgentsInput): Promise<ListRelayShareLinkAgentsResult> =>
      ownerRelayShareOperation(operation, async (operation, credentials, session) => {
        const query = input.cursor === undefined ? "" : `?cursor=${encodeURIComponent(input.cursor)}`;
        const relayResult = await session.run(() =>
          dependencies.relayJson(credentials, `${linkAgentsPath(operation.workspace.workspaceId, input)}${query}`),
        );
        const parsed = RelayShareLinkAgentsResponse.safeParse(relayResult);
        if (!parsed.success || parsed.data.nextCursor === input.cursor) throw invalidReply();
        return ListRelayShareLinkAgentsResult.parse({ agents: parsed.data.agents, nextCursor: parsed.data.nextCursor });
      }, assertOriginalWorkspace),

    disconnect: (operation: AgentsOperation<Workspace>, input: ShareLinkAgentDisconnectInput): Promise<DisconnectRelayShareLinkAgentResult> =>
      ownerRelayShareOperation(operation, async (operation, credentials, session) => {
        const relayResult = await session.run(() =>
          dependencies.relayJson(
            credentials,
            `${linkAgentsPath(operation.workspace.workspaceId, input)}/${encodeURIComponent(input.connectionId)}/disconnect`,
            { method: "POST" },
          ),
        );
        const parsed = RelayShareLinkAgentDisconnectResponse.safeParse(relayResult);
        if (!parsed.success || parsed.data.agent.connectionId !== input.connectionId) throw invalidReply();
        return DisconnectRelayShareLinkAgentResult.parse({ connectionId: input.connectionId });
      }, assertOriginalWorkspace),
  };
}
