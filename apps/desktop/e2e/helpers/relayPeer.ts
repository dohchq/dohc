// A minimal relay client for e2e specs that need a second machine. The legacy
// engine's client used to play that role and is being deleted; the daemon cannot
// take it over for file content (#356).

import type { RelayWorkspaceIdentity } from "./syncRelay";

const REQUEST_TIMEOUT_MS = 15_000;

/** A bearer-authenticated JSON request against the relay, status and body raw. */
export async function relayJson(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  // Without a deadline, a relay that accepts the connection and never answers
  // makes every `expect.poll` caller wait out the whole test timeout, and the
  // failure then names the poll rather than the hang.
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

/**
 * Claim a workspace bucket as the authenticated caller.
 *
 * Sends no replication identity: the relay adopts one on claim only when given
 * one and refuses every identity after the first, so a peer that adopted its own
 * would 409 the app's later push.
 */
export async function claimRelayWorkspace(input: {
  baseUrl: string;
  token: string;
  workspaceId: string;
}): Promise<void> {
  const claimed = await relayJson(input.baseUrl, input.token, "/sync/workspaces", {
    method: "POST",
    body: JSON.stringify({ workspaceId: input.workspaceId }),
  });
  if (claimed.status !== 200) {
    throw new Error(
      `relay refused the workspace claim for ${input.workspaceId}: ` +
        `${claimed.status} ${claimed.body}`,
    );
  }
}

/**
 * Does the relay serve a log for this workspace? 200 yes, 404 no, anything else
 * throws — reporting a 500 or a 409 as "no bucket" turns a broken relay into a
 * silent absence.
 *
 * `identity` is required once the relay has adopted one: the log routes are the
 * two the identity gate covers, so an identity-free read of an adopted workspace
 * answers 409 `identity_required`.
 */
export async function relayServesWorkspace(
  baseUrl: string,
  token: string,
  workspaceId: string,
  identity: RelayWorkspaceIdentity | null = null,
): Promise<boolean> {
  const query = new URLSearchParams({ since: "0", limit: "1" });
  if (identity) {
    query.set("replicationEpoch", identity.replicationEpoch);
    query.set("streamIdentity", identity.streamIdentity);
  }
  const read = await relayJson(
    baseUrl,
    token,
    `/sync/${encodeURIComponent(workspaceId)}/log?${query.toString()}`,
  );
  if (read.status === 200) return true;
  if (read.status === 404) return false;
  throw new Error(`relay log read for ${workspaceId} failed: ${read.status} ${read.body}`);
}
