export function linkSecret(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("Minted link URL must be a string");
  }
  const url = new URL(value);
  if (url.pathname !== "/s/") {
    throw new TypeError("Minted link URL must use the /s/ path");
  }
  const fragmentMarker = value.indexOf("#");
  const queryEnd = fragmentMarker === -1 ? value.length : fragmentMarker;
  if (value.slice(0, queryEnd).includes("?")) {
    throw new TypeError("Minted link URL must not include a query");
  }
  const secret = url.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    throw new TypeError("Minted link URL must have a 43-character base64url fragment");
  }
  return secret;
}
