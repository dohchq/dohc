import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

function address(value: string): string | null {
  const normalized = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(normalized) && !normalized.includes("%") ? normalized : null;
}

export function trustedAuthProxies(value: string | undefined): Set<string> {
  const result = new Set<string>();
  if (!value?.trim()) return result;
  for (const entry of value.split(",")) {
    const parsed = address(entry.trim());
    if (!parsed) throw new Error("DOHC_AUTH_TRUSTED_PROXIES must contain exact proxy IP addresses.");
    result.add(parsed);
  }
  return result;
}

/** Derive the limiter address from the socket before Better Auth sees headers. */
export function authClientAddress(peer: string | undefined, forwarded: string | string[] | undefined, trusted: ReadonlySet<string>): string {
  const direct = address(peer ?? "");
  if (!direct) throw new Error("The auth connection has no IP address.");
  if (!trusted.has(direct) || typeof forwarded !== "string" || forwarded.length > 4096) return direct;
  const chain = forwarded.split(",").map(value => address(value.trim()));
  if (!chain.length || chain.length > 32 || chain.some(value => value === null)) return direct;
  for (let index = chain.length - 1; index >= 0; index--) {
    const candidate = chain[index]!;
    if (!trusted.has(candidate)) return candidate;
  }
  return direct;
}

export function sanitizeAuthHeaders(headers: IncomingHttpHeaders, peer: string | undefined, trusted: ReadonlySet<string>): void {
  const client = authClientAddress(peer, headers["x-forwarded-for"], trusted);
  // Better Auth is configured to read only this server-owned value.
  headers["x-dohc-auth-client-ip"] = client;
  delete headers["x-forwarded-for"];
  delete headers["x-real-ip"];
  delete headers["cf-connecting-ip"];
  delete headers["forwarded"];
}
