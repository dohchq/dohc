import { parse } from "tldts";

export interface AppLaunchConfig { viewerOrigin: string; appDomain: string }

export function parseAppLaunchConfig(value: AppLaunchConfig): AppLaunchConfig {
  const viewer = new URL(value.viewerOrigin);
  const app = parse(value.appDomain, { allowPrivateDomains: true });
  const parent = parse(viewer.hostname, { allowPrivateDomains: true });
  const launch = parse(`${"0".repeat(48)}.${value.appDomain}`, { allowPrivateDomains: true });
  const validAppDomain = app.domain === value.appDomain || (app.isPrivate && app.publicSuffix === value.appDomain);
  if (viewer.protocol !== "https:" || viewer.origin !== value.viewerOrigin || viewer.port ||
      !/^[a-z0-9.-]+$/.test(value.appDomain) || !validAppDomain || !launch.domain ||
      !(app.isIcann || app.isPrivate) || !parent.domain || !(parent.isIcann || parent.isPrivate) ||
      `.${value.appDomain}`.endsWith(`.${parent.domain}`) || `.${parent.hostname}`.endsWith(`.${value.appDomain}`)) {
    throw new TypeError("Apps require separate HTTPS domains. Use a registrable app domain or a private Public Suffix List suffix.");
  }
  return { viewerOrigin: viewer.origin, appDomain: value.appDomain };
}
