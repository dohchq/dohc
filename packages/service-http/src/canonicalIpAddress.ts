import { isIP } from "node:net";

/**
 * The comparable form of an exact IP literal, or null for anything else.
 * IPv6 is normalized and an IPv4-mapped IPv6 address becomes dotted IPv4.
 * Zoned IPv6 addresses are refused.
 */
export function canonicalIpAddress(value: string): string | null {
  const version = isIP(value);
  if (!version || value.includes("%")) return null;
  if (version === 4) return value;
  const normalized = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}
