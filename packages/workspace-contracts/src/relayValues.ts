export const MAX_RELAY_URL_LENGTH = 2048;

// Canonical relay identity, or null when the value is not an acceptable
// relay URL (0P-C gate fix). Beyond scheme/length checks this rejects
// credentials, query strings, and fragments outright: buildSyncCode would
// otherwise expose secrets in a copyable/screenshot-readable code,
// parseSyncCode would accept them from pasted input, and relayUrlsMatch is
// an authz gate that must compare relay identities, not secret carriers.
export function canonicalRelayUrl(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_RELAY_URL_LENGTH) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname.replace(/\/+$/u, "");
    const canonical = url.toString().replace(/\/$/u, "");
    return canonical.length > MAX_RELAY_URL_LENGTH ? null : canonical;
  } catch {
    return null;
  }
}

// Canonical relay-identity compare: the token only ever goes to the relay
// the user signed in with, so equality here is a security gate, not
// cosmetics. Either side failing canonicalization (credentials, query,
// fragment, non-http(s)) can never "match".
export function relayUrlsMatch(left: string, right: string): boolean {
  const normalizedLeft = canonicalRelayUrl(left);
  const normalizedRight = canonicalRelayUrl(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

// The relay HTTP API version this build speaks. Every first-party relay
// client sends it in this header, and the relay refuses a version it does not
// serve with `api_version_too_old` or `api_version_too_new`. Raise it when a
// relay route, body, or code changes meaning, and keep the Rust relay client's
// copy in `crates/dohc-engine-sync-http` equal.
export const RELAY_API_VERSION_HEADER = "x-dohc-api-version";
export const RELAY_API_VERSION = 1;

// Share-web and the relay have independent wire contracts. Never stamp the
// relay version onto share-web requests, even when both counters are equal.
export const SHARE_WEB_API_VERSION_HEADER = "x-dohc-share-web-api-version";
export const SHARE_WEB_API_VERSION = 1;

export interface ApiVersionRange {
  readonly min: number;
  readonly max: number;
}

export type ApiVersionCheck = "accepted" | "malformed" | "too_old" | "too_new";

// Versions select wire shapes only. Authentication, grants, revocation and
// resource limits must apply equally to every accepted version.
export function checkApiVersion(named: string | null, versions: ApiVersionRange): ApiVersionCheck {
  if (named !== null && !/^[1-9][0-9]{0,8}$/.test(named)) return "malformed";
  const version = named === null ? 1 : Number(named);
  if (version < versions.min) return "too_old";
  if (version > versions.max) return "too_new";
  return "accepted";
}
