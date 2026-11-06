import { isIP } from "node:net";

export const DEFAULT_PUSH_HOSTS: ReadonlySet<string> = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  ".notify.windows.com",
]);

/** A leading dot admits subdomains, without admitting the parent or suffix lookalikes. */
export function pushHostAllowed(hostname: string, hosts: ReadonlySet<string>): boolean {
  return [...hosts].some(host => host.startsWith(".")
    ? hostname.length > host.length && hostname.endsWith(host)
    : hostname === host);
}

export function pushEndpointUrl(endpoint: string, hosts: ReadonlySet<string>): URL | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (endpoint.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.hash ||
    (url.port && url.port !== "443") || isIP(url.hostname.replace(/^\[|\]$/gu, "")) || !pushHostAllowed(url.hostname, hosts)) {
    return null;
  }
  return url;
}
