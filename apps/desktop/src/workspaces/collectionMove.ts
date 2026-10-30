import type { DatasetPlace } from "@dohc/cli/dataset";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { LocalDatasetHost } from "./localDatasetHost";
import type { DatasetTransferStatus } from "./localDatasetTransfer";
import { createRemoteDatasetTransferTarget } from "./remoteDataset";

/** The transfer record of a Collection whose move to a server finished. */
export type FinishedTransfer = DatasetTransferStatus & { state: "imported" };

/**
 * Where a Collection is, from its finished transfer record on this computer.
 * `relayUrl` is the workspace's server, or null when it has none. dohc asks
 * what the server runs only for a Collection with automations.
 */
export async function collectionPlace(input: {
  transfer: FinishedTransfer | null;
  relayUrl: string | null;
  automations(): Promise<{ automations: number; scheduledAutomations: number }>;
  runs(): Promise<"all" | "no-schedules" | "off" | null>;
}): Promise<DatasetPlace> {
  if (input.transfer) return { kind: "server", host: new URL(input.transfer.targetOrigin).host };
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

/**
 * A Collection's transfer record once its move has finished, or null for one
 * only on this computer. A read waits for the move this app is running, even
 * one still preparing its archive. A move that stopped partway resumes to the
 * same server, because its owner agreed to the move before it began.
 */
export async function finishedTransfer(input: {
  local: Pick<LocalDatasetHost, "transferStatus" | "transferInFlight" | "transferToShared">;
  workspaceId: string; datasetId: string;
  /** The workspace's server session, asked for only to resume a move. */
  server(): Promise<{ credentials: CloudCredentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  relayStream(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
  signal: AbortSignal;
}): Promise<FinishedTransfer | null> {
  const moving = input.local.transferInFlight(input.datasetId);
  const failure = moving ? await abortable(moving, input.signal).then(() => null, (error: unknown) => error) : null;
  input.signal.throwIfAborted();
  const transfer = input.local.transferStatus(input.datasetId);
  if (!transfer || transfer.state === "imported") return transfer as FinishedTransfer | null;
  if (moving) throw failure ?? new Error("This Collection's move didn't finish. Try again.");
  const host = new URL(transfer.targetOrigin).host;
  const needsHost = (cause?: unknown) => new Error(`This Collection is moving to ${host}. Sign in to ${host} to finish the move.`, { cause });
  const { credentials, credentialGeneration } = await input.server().catch((error: unknown) => { throw needsHost(error); });
  input.signal.throwIfAborted();
  if (!credentials.relayUrl || new URL(credentials.relayUrl).origin !== transfer.targetOrigin) throw needsHost();
  await moveCollectionToServer({ ...input, credentials, credentialGeneration });
  input.signal.throwIfAborted();
  const finished = input.local.transferStatus(input.datasetId);
  if (finished?.state !== "imported") throw new Error("This Collection's move didn't finish. Try again.");
  return finished as FinishedTransfer;
}

// Settles with the work, or rejects when the signal aborts. Aborting stops only the wait, not the work.
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
