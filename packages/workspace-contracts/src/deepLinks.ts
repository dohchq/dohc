import { canonicalRelayUrl } from "./relayValues";
import { isWorkReference, workLinkServerOrigin, type WorkLink } from "./workLinks";

// Public OS URL contract. Two hosts are public:
// dohc://open/<43-character base64url code>?relay=<encoded canonical relay URL>.
// dohc://l/<43-character work reference>?server=<encoded server origin>.
// Share-web gives these URLs to users. Keep the grammar independent of tab IDs.
export const DOHC_DEEP_LINK_SCHEME = "dohc";
const SHARE_HANDOFF_URL_PATTERN =
  /^([A-Za-z]+):\/\/([A-Za-z]+)\/([A-Za-z0-9_-]{43})\?relay=([^&#]+)$/u;
const WORK_LINK_HANDOFF_URL_PATTERN =
  /^([A-Za-z]+):\/\/([A-Za-z]+)\/([A-Za-z0-9_-]{43})\?server=([^&#]+)$/u;

declare const shareHandoffCodeBrand: unique symbol;
type ShareHandoffCode = string & { readonly [shareHandoffCodeBrand]: true };

export interface ShareHandoffIntent {
  readonly code: ShareHandoffCode;
  readonly relayUrl: string;
}

export function parseShareHandoffUrl(
  rawArgument: string,
): ShareHandoffIntent | null {
  const match = SHARE_HANDOFF_URL_PATTERN.exec(rawArgument);
  if (
    match?.[0] !== rawArgument ||
    match[1]?.toLowerCase() !== DOHC_DEEP_LINK_SCHEME ||
    match[2]?.toLowerCase() !== "open" ||
    match[3] === undefined ||
    match[4] === undefined
  ) {
    return null;
  }
  let decodedRelayUrl: string;
  try {
    decodedRelayUrl = decodeURIComponent(match[4]);
  } catch {
    return null;
  }
  const relayUrl = canonicalRelayUrl(decodedRelayUrl);
  if (
    relayUrl === null ||
    relayUrl !== decodedRelayUrl ||
    encodeURIComponent(relayUrl) !== match[4]
  ) {
    return null;
  }
  return { code: match[3] as ShareHandoffCode, relayUrl };
}

export function buildShareHandoffUrl(code: string, relayUrl: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) {
    throw new Error("invalid handoff code");
  }
  const url = `${DOHC_DEEP_LINK_SCHEME}://open/${code}?relay=${encodeURIComponent(relayUrl)}`;
  if (parseShareHandoffUrl(url) === null) {
    throw new Error("invalid handoff relay coordinate");
  }
  return url;
}

export function parseWorkLinkHandoffUrl(rawArgument: string): WorkLink | null {
  const match = WORK_LINK_HANDOFF_URL_PATTERN.exec(rawArgument);
  if (
    match?.[0] !== rawArgument ||
    match[1]?.toLowerCase() !== DOHC_DEEP_LINK_SCHEME ||
    match[2]?.toLowerCase() !== "l" ||
    match[3] === undefined ||
    match[4] === undefined
  ) {
    return null;
  }
  let decodedServer: string;
  try {
    decodedServer = decodeURIComponent(match[4]);
  } catch {
    return null;
  }
  const server = workLinkServerOrigin(decodedServer);
  if (
    server === null ||
    server !== decodedServer ||
    encodeURIComponent(server) !== match[4]
  ) {
    return null;
  }
  return { server, reference: match[3] };
}

export function buildWorkLinkHandoffUrl(link: WorkLink): string {
  if (!isWorkReference(link.reference)) {
    throw new Error("invalid work reference");
  }
  const url = `${DOHC_DEEP_LINK_SCHEME}://l/${link.reference}?server=${encodeURIComponent(link.server)}`;
  if (parseWorkLinkHandoffUrl(url) === null) {
    throw new Error("invalid work link server");
  }
  return url;
}
