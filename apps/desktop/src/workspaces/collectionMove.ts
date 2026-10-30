import type { DatasetPlace } from "@dohc/cli/dataset";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { LocalDatasetHost } from "./localDatasetHost";
import type { DatasetTransferStatus } from "./localDatasetTransfer";
import { createRemoteDatasetTransferTarget } from "./remoteDataset";

/**
 * Where a Collection is, from its transfer record on this computer.
 * `relayUrl` is the workspace's server, or null when it has none. dohc asks
 * what the server runs only for a Collection with automations.
 */
export async function collectionPlace(input: {
  transfer: DatasetTransferStatus | null;
  relayUrl: string | null;
  automations(): Promise<{ automations: number; scheduledAutomations: number }>;
  runs(): Promise<"all" | "no-schedules" | "off" | null>;
}): Promise<DatasetPlace> {
  if (input.transfer) {
    if (input.transfer.state !== "imported") throw new Error("This Collection is transferring. Wait for the transfer to finish, then retry.");
    return { kind: "server", host: new URL(input.transfer.targetOrigin).host };
  }
  if (!input.relayUrl) return { kind: "here", server: null };
  const counts = await input.automations();
  return { kind: "here", server: { host: new URL(input.relayUrl).host, runs: counts.automations ? await input.runs() : null, ...counts } };
}

/**
 * Moves a Collection that is only on this computer to the workspace's server,
 * which then holds it for good. Publishing a Collection app on a link and
 * giving a person access both move it there.
 */
export async function moveCollectionToServer(input: {
  local: Pick<LocalDatasetHost, "transferToShared">;
  workspaceId: string; datasetId: string;
  credentials: CloudCredentials; credentialGeneration: number; currentCredentialGeneration(): number;
  relayStream(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
  signal: AbortSignal;
}): Promise<void> {
  if (!input.credentials.relayUrl) throw new Error("Reconnect to your server, then try again.");
  const targetOrigin = new URL(input.credentials.relayUrl).origin;
  const target = createRemoteDatasetTransferTarget({ workspaceId: input.workspaceId, datasetId: input.datasetId, origin: targetOrigin,
    credentials: input.credentials, credentialGeneration: input.credentialGeneration, currentCredentialGeneration: input.currentCredentialGeneration,
    signal: input.signal, assertCurrent: () => input.signal.throwIfAborted(), relayStream: input.relayStream });
  await input.local.transferToShared({ datasetId: input.datasetId, targetOrigin, target, signal: input.signal });
}
