import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";

export function namedInvitationGrant(pathname: string, view: "edit" | "chat"): string | null {
  const match = new RegExp(`^/s/${view}/([^/]+)/?$`).exec(pathname);
  try {return match ? parseLiveUpdateIdentifier(decodeURIComponent(match[1]!)) : null;} catch {return null;}
}
