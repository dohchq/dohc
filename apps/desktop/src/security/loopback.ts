export function normalizeLoopbackHostname(hostname: string): string {
  // Node's WHATWG URL implementation currently returns "[::1]" for hostname,
  // so normalize both bracketed and unbracketed forms before comparison.
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeLoopbackHostname(hostname);
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}
