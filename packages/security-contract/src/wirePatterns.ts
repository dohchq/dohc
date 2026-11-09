// Shapes of the opaque strings that cross the relay and share-web boundary.

/** 32 random bytes in base64url: link secrets, capability tokens, handoff codes, profile secrets. */
export const BASE64URL_32_BYTES_SOURCE = "[A-Za-z0-9_-]{43}";
export const LINK_SECRET_PATTERN = new RegExp(`^${BASE64URL_32_BYTES_SOURCE}$`, "u");

/** A lowercase hex SHA-256 digest, the relay blob address. */
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/** The most redirect URIs one agent client registers. */
export const AGENT_REDIRECT_URI_LIMIT = 10;
/** The longest client id, redirect URI, or MCP address in an agent's sign-in. */
export const AGENT_URI_CHAR_LIMIT = 2_048;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/**
 * A redirect URI an agent may register (RFC 8252, OAuth 2.1): HTTPS, or HTTP
 * to a loopback address for a native client, with no fragment or user information.
 */
export function isAgentRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > AGENT_URI_CHAR_LIMIT || CONTROL_CHARS.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost";
  return !parsed.hash && !parsed.username && !parsed.password &&
    (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback));
}
