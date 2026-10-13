import {parseRoute} from "./relayRoute";

const linkLivePaths = new Set(["/sync/live/link-tickets", "/sync/live/link-session", "/sync/live/link-document"]);

export function isLinkLivePath(pathname: string): boolean {
  return linkLivePaths.has(pathname);
}

export function isLinkEndpointPath(pathname: string): boolean {
  if (isLinkLivePath(pathname)) return true;
  try {
    const url = new URL("http://relay.invalid");
    url.pathname = pathname;
    const route = parseRoute({url: url.href});
    return route.route.startsWith("link-") ||
      (route.route === "app-backend" && route.workspaceId === undefined);
  } catch {
    return false;
  }
}
