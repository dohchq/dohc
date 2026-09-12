import { parse } from "tldts";

export interface AppLaunchConfig { viewerOrigin: string; appDomain: string }

export function parseAppLaunchConfig(value: AppLaunchConfig): AppLaunchConfig {
  const viewer = new URL(value.viewerOrigin);
  const app = parse(value.appDomain, { allowPrivateDomains: true });
  const parent = parse(viewer.hostname, { allowPrivateDomains: true });
  if (viewer.protocol !== "https:" || viewer.origin !== value.viewerOrigin || viewer.port ||
      !/^[a-z0-9.-]+$/.test(value.appDomain) || app.domain !== value.appDomain ||
      !(app.isIcann || app.isPrivate) || !parent.domain || !(parent.isIcann || parent.isPrivate) ||
      app.domain === parent.domain) throw new TypeError("Apps require separate configured HTTPS registrable domains.");
  return { viewerOrigin: viewer.origin, appDomain: value.appDomain };
}
