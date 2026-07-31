import type { WorkspaceId } from "@dohc/workspace-contracts/engine";
import {
  decodeRelayWorkspaceBootstrap,
  RelayConflictError,
  RelayUnauthorizedError,
  RelayWorkspaceUnavailableError,
  type RelayWorkspaceBootstrapResult,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";

function relayUrl(relay: SyncRelayConnection, path: string): string {
  return `${relay.baseUrl.replace(/\/+$/u, "")}${path}`;
}

async function jsonRelay<T>(
  relay: SyncRelayConnection,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${relay.token}`);
  const response = await (relay.fetch ?? fetch)(relayUrl(relay, path), {
    ...init,
    headers,
  });
  if (response.status === 401) throw new RelayUnauthorizedError();
  if (response.status === 404) throw new RelayWorkspaceUnavailableError();
  if (response.status === 409) throw new RelayConflictError();
  if (!response.ok) throw new Error(`Relay request failed (${response.status})`);
  return (await response.json()) as T;
}

export async function probeRelayWorkspace(input: {
  workspaceId: WorkspaceId;
  relay: SyncRelayConnection;
}): Promise<RelayWorkspaceBootstrapResult> {
  const bootstrap = await jsonRelay<unknown>(
    input.relay,
    `/sync/${encodeURIComponent(input.workspaceId)}/bootstrap`,
  );
  return decodeRelayWorkspaceBootstrap(bootstrap);
}
