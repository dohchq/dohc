import { createRemoteDatasetData, type OwnerDatasetData } from "./remoteDataset";
import { recordedShareSelector } from "./shareViewRecords";
import type { CloudCredentials } from "./cloudCredentialStore";

/** Source View/Edit and Collection data permissions are separate. The relay resolves the named grant. */
export function createNamedDatasetData(input: {
  workspaceId: string; shareView: unknown; credentials: CloudCredentials; credentialGeneration: number; signal: AbortSignal;
  currentCredentialGeneration(): number; assertCurrent(): void;
  relayJson(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
}): Pick<OwnerDatasetData, "list" | "describe" | "invoke" | "upload" | "file"> {
  const marker = input.shareView as { shareId?: unknown; relayUrl?: unknown; grantedSelector?: unknown; ended?: unknown } | null;
  if (!marker || typeof marker !== "object" || Array.isArray(marker) || typeof marker.shareId !== "string" || !marker.shareId || marker.shareId.length > 200 ||
    marker.ended !== undefined && marker.ended !== false || !recordedShareSelector(marker.grantedSelector) || typeof marker.relayUrl !== "string" || !input.credentials.relayUrl) {
    throw new Error("This shared workspace is unavailable. Open its current share again.");
  }
  const relay = new URL(marker.relayUrl), credentialsRelay = new URL(input.credentials.relayUrl);
  if (!["http:", "https:"].includes(relay.protocol) || relay.username || relay.password || relay.search || relay.hash ||
    relay.href.replace(/\/+$/, "") !== credentialsRelay.href.replace(/\/+$/, "")) throw new Error("Sign in to the server this shared workspace uses.");
  const data = createRemoteDatasetData({ ...input, shareId: marker.shareId });
  return { list: data.list, describe: data.describe, invoke: data.invoke, upload: data.upload, file: data.file };
}
