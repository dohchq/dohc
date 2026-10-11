// The report services a release build names. electron.vite.config.ts
// compiles them in from DOHC_POSTHOG_KEY, DOHC_POSTHOG_HOST, DOHC_SENTRY_DSN
// and DOHC_SENTRY_DIST; an empty value names no service.
// docs/engineering/desktop-release.md says how a release owner sets them.
export interface ReportingBuild {
  posthogKey: string;
  posthogHost: string;
  sentryDsn: string;
  dist: string;
}

declare const __DOHC_REPORTING__: ReportingBuild | undefined;

export const REPORTING_BUILD: ReportingBuild | null =
  typeof __DOHC_REPORTING__ === "undefined" ? null : __DOHC_REPORTING__;

export interface UsageService {
  // PostHog's batch endpoint.
  url: URL;
  key: string;
}

export interface ErrorService {
  // Sentry's envelope endpoint.
  url: URL;
  publicKey: string;
}

// Where this build sends reports, and the names the reports carry. Null
// sends nothing.
export interface Reporting {
  usage: UsageService | null;
  errors: ErrorService | null;
  release: string;
  dist: string;
  environment: string;
}

// The switches that turn every report off for a launch, whatever the
// settings say. DO_NOT_TRACK is the common convention.
const OFF_VALUES = new Set(["0", "off", "false", "no"]);

/**
 * Only a packaged build with a named service reports. A development build,
 * a test run, an isolated test launch, DOHC_TELEMETRY=off and DO_NOT_TRACK=1
 * all send nothing.
 */
export function resolveReporting(input: {
  build: ReportingBuild | null;
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  version: string;
  channel: string;
}): Reporting | null {
  const { build, env } = input;
  if (!build || !input.packaged) return null;
  if (env.DOHC_DESKTOP_TEST === "1" || input.argv.includes("--dohc-isolated-test")) return null;
  if (OFF_VALUES.has(env.DOHC_TELEMETRY?.trim().toLowerCase() ?? "")) return null;
  if (env.DO_NOT_TRACK?.trim() === "1") return null;
  const usage = usageService(build.posthogKey, build.posthogHost);
  const errors = errorService(build.sentryDsn);
  if (!usage && !errors) return null;
  return {
    usage,
    errors,
    release: `dohc-desktop@${input.version}`,
    dist: /^[\w.-]{1,64}$/.test(build.dist) ? build.dist : `${process.platform}-${process.arch}`,
    environment: input.channel,
  };
}

function httpsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : null;
}

export function usageService(key: string, host: string): UsageService | null {
  if (!/^phc_\w{10,100}$/.test(key.trim())) return null;
  const base = httpsUrl(host);
  if (!base) return null;
  return { url: new URL(`${base.pathname.replace(/\/+$/, "")}/batch/`, base), key: key.trim() };
}

// A DSN is https://<public key>@<host><path>/<project id>. The envelope
// endpoint is https://<host><path>/api/<project id>/envelope/.
export function errorService(dsn: string): ErrorService | null {
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  const match = /^(.*)\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || !/^[a-f0-9]{16,64}$/.test(url.username) || !match) return null;
  const base = new URL(`https://${url.host}`);
  return { url: new URL(`${match[1]}/api/${match[2]}/envelope/`, base), publicKey: url.username };
}
