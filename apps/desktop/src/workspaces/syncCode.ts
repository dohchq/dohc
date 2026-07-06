// The copyable "sync code" — the join handle for adding a synced workspace
// on another machine. One human-readable line carrying exactly the two facts
// a second machine needs: which workspace, and which relay it syncs through.
//
//   dohc-sync:<workspaceId>:<relayUrl>
//
// Deliberately NOT opaque (no base64): the user can see what they are
// pasting, and support can read a code off a screenshot. Workspace ids are
// colon-free by construction (manifest ids are hostname-safe), so splitting
// on the first two colons is unambiguous; everything after the second colon
// is the relay URL (which itself contains colons).
//
// Security note for consumers: the relay URL in a PASTED code is untrusted
// input. The join flow never sends the session token to it — it only checks
// that it matches the relay the user is already signed in to (see the join
// handler in main.ts).

const SYNC_CODE_PREFIX = "dohc-sync";
const MAX_WORKSPACE_ID_LENGTH = 200;
const MAX_RELAY_URL_LENGTH = 2048;

export interface SyncCodeParts {
  workspaceId: string;
  relayUrl: string;
}

function isValidWorkspaceId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_WORKSPACE_ID_LENGTH &&
    // The IPC contract's workspace-id charset (bridgeContract WORKSPACE_ID):
    // lowercase alphanumeric/hyphens — never colons or whitespace, so the
    // code format stays parseable.
    /^[a-z0-9][a-z0-9-]*$/u.test(value)
  );
}

// Canonical relay identity, or null when the value is not an acceptable
// relay URL (0P-C gate fix). Beyond scheme/length checks this REJECTS
// credentials, query strings, and fragments outright: buildSyncCode would
// otherwise expose secrets in a copyable/screenshot-readable code,
// parseSyncCode would accept them from pasted input, and relayUrlsMatch is
// an authz gate that must compare relay identities, not secret carriers.
function normalizeRelayUrl(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_RELAY_URL_LENGTH) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function buildSyncCode(parts: SyncCodeParts): string {
  if (!isValidWorkspaceId(parts.workspaceId)) {
    throw new Error("Workspace id cannot be encoded as a sync code.");
  }
  const relayUrl = normalizeRelayUrl(parts.relayUrl);
  if (relayUrl === null) {
    throw new Error("Relay URL cannot be encoded as a sync code.");
  }
  return `${SYNC_CODE_PREFIX}:${parts.workspaceId}:${relayUrl}`;
}

// Returns null for anything that is not a well-formed sync code — the caller
// owns the product-voiced error message.
export function parseSyncCode(code: string): SyncCodeParts | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(`${SYNC_CODE_PREFIX}:`)) return null;
  const rest = trimmed.slice(SYNC_CODE_PREFIX.length + 1);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const workspaceId = rest.slice(0, separator);
  const relayUrl = normalizeRelayUrl(rest.slice(separator + 1));
  if (!isValidWorkspaceId(workspaceId) || relayUrl === null) return null;
  return { workspaceId, relayUrl };
}

// Canonical relay-identity compare: the token only ever goes to the relay
// the user signed in with, so equality here is a security gate, not
// cosmetics. Either side failing canonicalization (credentials, query,
// fragment, non-http(s)) can never "match".
export function relayUrlsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeRelayUrl(left);
  const normalizedRight = normalizeRelayUrl(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}
