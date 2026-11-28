import { clientAddress } from "@dohc/service-http";

/** Only incoming webhooks read a forwarded sender; every other limiter keeps the peer. */
export function relayClientAddress(
  pathname: string,
  peerAddress: string | undefined,
  forwardedFor: string | null,
  trustedProxies: ReadonlySet<string>,
): string {
  return pathname.startsWith("/sync/hooks/")
    ? clientAddress(peerAddress, forwardedFor, trustedProxies)
    : (peerAddress ?? "unknown");
}
