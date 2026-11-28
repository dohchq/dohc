import { canonicalIpAddress } from "./canonicalIpAddress";

export function clientAddress(
  peerAddress: string | undefined,
  forwardedFor: string | null,
  trustedProxies: ReadonlySet<string>,
): string {
  const peer = canonicalIpAddress(peerAddress ?? "");
  if (!peer) return "unknown";
  if (!trustedProxies.has(peer)) return peer;
  const entries = forwardedFor?.split(",") ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]?.trim();
    if (!entry) continue;
    const candidate = canonicalIpAddress(entry);
    if (!candidate) return peer;
    if (!trustedProxies.has(candidate)) return candidate;
  }
  return "unknown";
}

/**
 * Rate-limit key for one sender. One IPv6 connection usually holds a whole
 * /64, so the key is that prefix; an IPv4 address is its own key.
 */
export function senderAddressKey(address: string): string {
  const canonical = canonicalIpAddress(address);
  if (!canonical) return "unknown";
  if (!canonical.includes(":")) return canonical;
  const [head = "", tail = ""] = canonical.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = canonical.includes("::")
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).join(":")}::/64`;
}
