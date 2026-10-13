// The PostHog project a release build reports to. electron.vite.config.ts
// compiles it in from DOHC_POSTHOG_KEY, DOHC_POSTHOG_HOST and
// DOHC_DESKTOP_DIST; an empty value names no project.
// docs/engineering/desktop-release.md says how a release owner sets them.
export interface ReportingBuild {
  posthogKey: string;
  posthogHost: string;
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
  // The PostHog host the SDK sends to.
  host: string;
  key: string;
}

// Where this build sends reports, and the package it names. Null sends
// nothing.
export interface Reporting {
  usage: UsageService | null;
  errors: ErrorService | null;
  // The platform and processor the package was built for, such as "win-x64".
  dist: string;
}

// The switches that turn every report off for a launch, whatever the
// settings say. DO_NOT_TRACK is the common convention.
const OFF_VALUES = new Set(["0", "off", "false", "no"]);

/**
 * Only a packaged build with a named project reports. A development build,
 * a test run, an isolated test launch, DOHC_TELEMETRY=off and DO_NOT_TRACK=1
 * all send nothing.
 */
export function resolveReporting(input: {
  build: ReportingBuild | null;
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
}): Reporting | null {
  const { build, env } = input;
  if (!build || !input.packaged) return null;
  if (env.DOHC_DESKTOP_TEST === "1" || input.argv.includes("--dohc-isolated-test")) return null;
  if (OFF_VALUES.has(env.DOHC_TELEMETRY?.trim().toLowerCase() ?? "")) return null;
  if (env.DO_NOT_TRACK?.trim() === "1") return null;
  const project = posthogProject(build.posthogKey, build.posthogHost);
  if (!project) return null;
  const base = project.base.href.replace(/\/+$/, "");
  return {
    usage: { url: new URL(`${base}/batch/`), key: project.key },
    errors: { host: base, key: project.key },
    dist: /^[\w.-]{1,64}$/.test(build.dist) ? build.dist : `${process.platform}-${process.arch}`,
  };
}

/** A project key and an https host, or null when either is unusable. */
export function posthogProject(key: string, host: string): { key: string; base: URL } | null {
  if (!/^phc_\w{10,100}$/.test(key.trim())) return null;
  let base: URL;
  try {
    base = new URL(host.trim());
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return null;
  return { key: key.trim(), base };
}
