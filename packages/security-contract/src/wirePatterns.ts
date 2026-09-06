// Shapes of the opaque strings that cross the relay and share-web boundary.

/** 32 random bytes in base64url: link secrets, capability tokens, handoff codes, profile secrets. */
export const BASE64URL_32_BYTES_SOURCE = "[A-Za-z0-9_-]{43}";
export const LINK_SECRET_PATTERN = new RegExp(`^${BASE64URL_32_BYTES_SOURCE}$`, "u");

/** A lowercase hex SHA-256 digest, the relay blob address. */
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
