export function clientAddress(
  peerAddress: string | undefined,
  forwardedFor: string | null,
  trustedProxies: ReadonlySet<string>,
): string {
  if (peerAddress === undefined || !trustedProxies.has(peerAddress)) {
    return peerAddress ?? "unknown";
  }
  const entries = forwardedFor?.split(",") ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]?.trim();
    if (entry && !trustedProxies.has(entry)) return entry;
  }
  return "unknown";
}
