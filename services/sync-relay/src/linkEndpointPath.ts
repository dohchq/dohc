import {relayPathSegments} from "./requestInputs";

const linkLivePaths = new Set(["/sync/live/link-tickets", "/sync/live/link-session", "/sync/live/link-document"]);
const linkReadRoutes = new Set(["share", "current", "log", "discussion", "collection-writes"]);
const linkCredentialRoutes = new Set(["link-exchange", "link-refresh", "link-handoff", "link-redeem"]);

export function isLinkLivePath(pathname: string): boolean {
  return linkLivePaths.has(pathname);
}

export function isLinkEndpointPath(pathname: string): boolean {
  if (isLinkLivePath(pathname)) return true;
  try {
    const parts = relayPathSegments(pathname);
    if (parts[0] !== "sync") return false;
    if (parts.length === 2) return linkCredentialRoutes.has(parts[1]!);
    if (parts[1] !== "link") return false;
    if (parts[2] === "app-publications") return true;
    return (parts.length === 3 && linkReadRoutes.has(parts[2]!)) ||
      (parts.length === 4 && (parts[2] === "blobs" ||
        (parts[2] === "discussion" && parts[3] === "activity")));
  } catch {
    return false;
  }
}
