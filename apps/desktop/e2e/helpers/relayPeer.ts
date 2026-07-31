// A minimal relay client for e2e specs that need a SECOND machine.
//
// The specs used to borrow `packages/workspace-engine`'s relay client for this,
// which is being deleted. The daemon cannot stand in for the peer either: file
// writes land in `replication_journal` and nothing reads that table
// (`dohc-engine-domain/src/store.rs` writes it; the only reader anywhere is a
// COUNT(*) helper), so the daemon applies file ops inbound but cannot send them.
// That is #356, and until it lands a peer has to speak HTTP directly.
//
// Speaking the routes directly is not a downgrade. The relay's wire contract is
// what these specs are exercising, and `services/sync-relay`'s own suites drive
// it the same way.

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
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  return { status: response.status, body: await response.text() };
}

/**
 * Claim a workspace bucket as the authenticated caller.
 *
 * Deliberately sends NO replication identity, matching what the legacy client
 * did. The relay adopts an identity on claim only when one is supplied
 * (`services/sync-relay/src/server.ts`), so a peer that pre-adopted its own
 * would make the app's later push 409 — the relay refuses every identity but
 * the first.
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
 * Does the relay hold a bucket for this workspace? A claimed bucket answers its
 * log with 200 (even when empty); an unclaimed one 404s.
 *
 * This is what a spec should assert when the property under test is "the app
 * claimed the bucket". Asserting that a second machine then PULLS the app's file
 * content is a different property, and one the daemon cannot satisfy until #356.
 */
export async function relayBucketExists(
  baseUrl: string,
  token: string,
  workspaceId: string,
): Promise<boolean> {
  const read = await relayJson(
    baseUrl,
    token,
    `/sync/${encodeURIComponent(workspaceId)}/log?since=0&limit=1`,
  );
  return read.status === 200;
}
