import {relayPathSegments} from "./requestInputs";

const linkLivePaths = new Set(["/sync/live/link-tickets", "/sync/live/link-session", "/sync/live/link-document"]);
const linkCredentialRoutes = new Set(["link-exchange", "link-refresh", "link-handoff", "link-redeem"]);

export function isLinkLivePath(pathname: string): boolean {
  return linkLivePaths.has(pathname);
}

export function isLinkEndpointPath(pathname: string): boolean {
  if (isLinkLivePath(pathname)) return true;
  try {
    const parts = relayPathSegments(pathname);
    return parts[0] === "sync" && (parts[1] === "link" ||
      (parts.length === 2 && linkCredentialRoutes.has(parts[1]!)));
  } catch {
    return false;
  }
}
