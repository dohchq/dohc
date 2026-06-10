// Phase 9: cloud sync is the existing local sync engine pointed at the hosted
// server. The only additions are the device-session Bearer token and the
// liberal confirmation policy — ordinary edits flow without ceremony.

import { requiresReview, type ChangeSet } from "@dohc/workspace-core";
import {
  createLocalSyncClient,
  type FetchLike,
  type LocalSyncClient,
} from "@dohc/workspace-fs";

export type { FetchLike, LocalSyncClient } from "@dohc/workspace-fs";

export function createAuthorizedFetch(token: string, base: FetchLike = fetch): FetchLike {
  return (input, init) => {
    // Per fetch semantics init headers replace Request headers, so seed from
    // whichever set the caller actually provided before adding auth.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("authorization", `Bearer ${token}`);
    return base(input, { ...init, headers });
  };
}

export type CloudSyncOptions = {
  rootDir: string;
  remoteWorkspaceId: string;
  serverUrl: string;
  token: string;
  fetch?: FetchLike;
};

export function createCloudSync({
  rootDir,
  remoteWorkspaceId,
  serverUrl,
  token,
  fetch: base = fetch,
}: CloudSyncOptions): LocalSyncClient {
  return createLocalSyncClient({
    rootDir,
    workspaceId: remoteWorkspaceId,
    baseUrl: serverUrl,
    fetch: createAuthorizedFetch(token, base),
  });
}

// Liberal by default: normal edits auto-sync; permission changes, public
// sharing, and other boundary crossings require explicit confirmation.
export function syncDecision(set: ChangeSet): "auto" | "needs-confirmation" {
  return requiresReview(set) ? "needs-confirmation" : "auto";
}
