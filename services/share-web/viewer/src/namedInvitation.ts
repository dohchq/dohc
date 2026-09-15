import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";

export function namedInvitationGrant(pathname: string): string | null {
  const match = /^\/s\/edit\/([^/]+)\/?$/.exec(pathname);
  try {return match ? parseLiveUpdateIdentifier(decodeURIComponent(match[1]!)) : null;} catch {return null;}
}
