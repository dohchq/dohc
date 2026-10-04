import type { WorkspaceId } from "@dohc/workspace-contracts/engine";
import {
  decodeRelayWorkspaceBootstrap,
  RelayConflictError,
  RelayWorkspaceUnavailableError,
  type RelayWorkspaceBootstrapResult,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { relayRequest } from "./relayRequest";

export async function probeRelayWorkspace(input: {
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
  signal?: AbortSignal;
}): Promise<RelayWorkspaceBootstrapResult> {
  const response = await relayRequest({
    relay: input.relay,
    path: `/sync/${encodeURIComponent(input.workspaceId)}/bootstrap`,
    init: { signal: input.signal ?? null },
    errors: {
      404: () => new RelayWorkspaceUnavailableError(),
      409: () => new RelayConflictError(),
    },
    label: "Relay request",
  });
  return decodeRelayWorkspaceBootstrap((await response.json()) as unknown);
}
