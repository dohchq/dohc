import {canonicalIpAddress} from "@dohc/service-http";

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
