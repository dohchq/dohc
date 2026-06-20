export function normalizeLoopbackHostname(hostname: string): string {
  // Node's WHATWG URL implementation currently returns "[::1]" for hostname,
  // so normalize both bracketed and unbracketed forms before comparison.
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeLoopbackHostname(hostname).toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    isIpv4Loopback(normalized) ||
    (normalized.startsWith("::ffff:") && isIpv4MappedLoopback(normalized.slice("::ffff:".length)))
  );
}

function isIpv4MappedLoopback(suffix: string): boolean {
  if (isIpv4Loopback(suffix)) return true;
  const hextets = suffix.split(":");
  if (
    hextets.length !== 2 ||
    !hextets.every((part) => /^[0-9a-f]{1,4}$/i.test(part))
  ) {
    return false;
  }
  const high = Number.parseInt(hextets[0], 16);
  const low = Number.parseInt(hextets[1], 16);
  return isIpv4Loopback(
    [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
  );
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
