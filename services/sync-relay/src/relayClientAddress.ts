import { clientAddress } from "@dohc/service-http";
import { relayPathSegments } from "./requestInputs";

/** Only incoming webhooks read a forwarded sender; every other limiter keeps the peer. */
export function relayClientAddress(
  pathname: string,
  peerAddress: string | undefined,
  forwardedFor: string | null,
  trustedProxies: ReadonlySet<string>,
): string {
  return isIncomingWebhookPath(pathname)
    ? clientAddress(peerAddress, forwardedFor, trustedProxies)
    : (peerAddress ?? "unknown");
}

function isIncomingWebhookPath(pathname: string): boolean {
  try {
    const parts = relayPathSegments(pathname);
    return parts.length === 3 && parts[0] === "sync" && parts[1] === "hooks";
  } catch {
    return false;
  }
}
