export function normalizeLoopbackHostname(hostname: string): string {
  // Node's WHATWG URL implementation currently returns "[::1]" for hostname,
  // so normalize both bracketed and unbracketed forms before comparison.
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeLoopbackHostname(hostname);
  return normalized === "localhost" || normalized === "::1" || isIpv4Loopback(normalized);
}

function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}
